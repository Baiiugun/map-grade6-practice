"use strict";

function summarizeSupplement(rows) {
  const groups = new Map();
  for (const { answers: data } of rows) {
    if (typeof data?.student !== "string" || !data.student.trim() || !["en", "zh"].includes(data.lang)
        || !Number.isFinite(data.at) || !Number.isInteger(data.total) || data.total < 1) continue;
    const key = JSON.stringify([data.student, data.lang]);
    let group = groups.get(key);
    if (!group) {
      group = { latest: data, questions: new Map() };
      groups.set(key, group);
    }
    if (data.at > group.latest.at) group.latest = data;
    for (const [id, answer] of Object.entries(data.answered || {})) {
      if (!Array.isArray(answer) || answer.length !== 4 || !Number.isFinite(answer[0])
          || !Number.isFinite(answer[2]) || typeof answer[1] !== "boolean" || typeof answer[3] !== "boolean") continue;
      const previous = group.questions.get(id);
      if (!previous) { group.questions.set(id, answer.slice()); continue; }
      if (answer[0] < previous[0]) [previous[0], previous[1]] = answer;
      if (answer[2] > previous[2]) [previous[2], previous[3]] = answer.slice(2);
    }
  }
  return [...groups.values()].sort((a, b) => b.latest.at - a.latest.at);
}

function watchSupplementReport(client) {
  const status = document.getElementById("supplement-status");
  const body = document.getElementById("supplement-rows");
  const table = document.getElementById("supplement-table");
  const filter = document.getElementById("supplement-filter");
  let groups = [], busy = false;
  function render() {
    const search = filter.value.trim().toLowerCase();
    const result = document.createDocumentFragment();
    for (const { latest: d, questions } of groups) {
      if (!d.student.toLowerCase().includes(search)) continue;
      const row = document.createElement("tr");
      const answered = questions.size;
      const attempts = [...questions.values()];
      const first = attempts.filter(q => q[1]).length;
      const outstanding = attempts.filter(q => !q[3]).length;
      const states = { reading: "阅读", paused: "已暂停", finished: "专项已完成", working: "练习" };
      const progress = [states[d.state], d.skill, d.passage, d.count ? d.pos + "/" + d.count : ""].filter(Boolean).join(" · ");
      const correct = answered ? Math.round(first / answered * 100) + "%（" + first + "/" + answered + "）" : "—";
      for (const value of [d.student, d.lang === "zh" ? "中文翻译版" : "英文原版",
        answered + " / " + d.total, correct, outstanding, progress, new Date(d.at).toLocaleString()]) {
        row.append(mapElement("td", String(value)));
      }
      result.append(row);
    }
    body.replaceChildren(result);
    table.hidden = !body.children.length;
    status.textContent = table.hidden ? (search ? "没有匹配的学生。" : "尚未收到补充阅读进度。") : "";
  }
  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      const rows = [];
      for (let start = 0; ; start += 100) {
        const { data, error } = await client.from("submissions").select("id,answers")
          .eq("task_type", "MAP-G6-Reading-Supplement").eq("status", "in_progress")
          .order("id").range(start, start + 99);
        if (error) throw error;
        rows.push(...data);
        if (data.length < 100) break;
      }
      groups = summarizeSupplement(rows);
      render();
    } catch (error) {
      status.textContent = "未能刷新阅读进度。" + mapMessage(error);
    } finally { busy = false; }
  }
  filter.addEventListener("input", render);
  document.getElementById("supplement-refresh").onclick = refresh;
  refresh();
  const timer = setInterval(() => { if (!document.hidden) refresh(); }, 10000);
  window.addEventListener("focus", refresh);
  return () => { clearInterval(timer); window.removeEventListener("focus", refresh); };
}
