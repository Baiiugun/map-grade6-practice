"use strict";

// Keep the classroom alias inside the teacher-only report. The existing student
// RPC uses a random, browser-specific owner key for this particular record.
function startSupplementSync(config, book, read, keysFor) {
  const base = "map-reading-sync-v1/";
  const pending = base + "pending/";
  const task = "MAP-G6-Reading-Supplement";
  let timer, busy = false;
  const badge = document.getElementById("supplement-sync");
  const message = (zh, en) => { badge.textContent = document.documentElement.lang === "en" ? en : zh; };
  const totals = {
    en: book.questions.length,
    zh: book.questions.filter(q => !q.skill.startsWith("C")).length,
  };
  const titles = new Map(book.passages.map(p => [p.id, p.title[1]]));
  const questions = new Map(book.questions.map(q => [q.id, q]));

  function record(student, lang, activity) {
    if (!student || student === "本机学生") return;
    try {
      const slot = encodeURIComponent(student) + "/" + lang;
      const ownerKey = base + "owner/" + slot;
      let owner = JSON.parse(localStorage.getItem(ownerKey));
      if (!owner) {
        owner = { id: crypto.randomUUID(), student_name: crypto.randomUUID() };
        localStorage.setItem(ownerKey, JSON.stringify(owner));
      }
      const prefix = keysFor(lang, student);
      const answered = {};
      for (const q of book.questions) {
        if (lang === "zh" && q.skill.startsWith("C")) continue;
        const tries = read(prefix + "q/" + q.id)?.tries;
        if (!tries?.length) continue;
        const first = tries[0], last = tries[tries.length - 1];
        answered[q.id] = [first.at, first.i === q.key, last.at, last.i === q.key];
      }
      const q = questions.get(activity.qid);
      const passage = q?.pages.map(id => titles.get(id)).join(" / ") || titles.get(activity.page) || "";
      const answers = { student, lang, total: totals[lang], answered, passage,
        skill: activity.skill || "", pos: activity.pos || 0, count: activity.total || 0,
        state: activity.status, at: activity.at };
      const row = { ...owner, task_type: task, set_num: lang === "zh" ? 1 : 2,
        si: 0, left_seconds: 0, time_used_seconds: 0, status: "in_progress", answers };
      localStorage.setItem(pending + slot, JSON.stringify(row));
      message("进度待同步", "Progress pending");
      schedule(200);
    } catch {
      message("浏览器未能保存同步记录，请允许网站存储。", "Allow browser storage to sync progress.");
    }
  }

  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(flush, delay);
  }
  async function flush() {
    if (busy) return;
    busy = true;
    async function send() {
      for (const key of Object.keys(localStorage).filter(k => k.startsWith(pending))) {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const response = await fetch(config.url + "/rest/v1/rpc/student_save", {
          method: "POST", headers: { apikey: config.key, Authorization: "Bearer " + config.key,
            "Content-Type": "application/json" }, body: JSON.stringify({ p: JSON.parse(raw) }),
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error("HTTP " + response.status);
        if (localStorage.getItem(key) === raw) localStorage.removeItem(key);
        message("进度已同步给老师", "Progress synced to your teacher");
      }
      if (Object.keys(localStorage).some(k => k.startsWith(pending))) schedule(100);
    }
    try {
      if (navigator.locks) await navigator.locks.request(base, send);
      else await send();
    } catch {
      message("进度仍在本机，将自动重试同步。", "Progress saved here. Sync will retry.");
      schedule(8000);
    } finally { busy = false; }
  }
  window.addEventListener("online", () => schedule(0));
  window.addEventListener("pageshow", () => schedule(0));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(0); });
  schedule(0);
  return record;
}
