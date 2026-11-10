"use strict";

const mapAttemptColumns = "id,paper_id,student,question_ids,answers,revision,started_at,updated_at,submitted_at,marks,grading,graded_at";
const mapMarks = { correct: "正确", incorrect: "错误", unscored: "不计分", unanswered: "未答" };
const mapClock = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

function mapReadBank(text) {
  const startTag = '<script id="practice-bank" type="application/json">';
  const start = text.indexOf(startTag);
  const end = text.indexOf("</script>", start + startTag.length);
  if (start < 0 || end < 0) throw new Error("请选择要导入的 MAP 本地老师版 HTML。");
  const bank = JSON.parse(text.slice(start + startTag.length, end));
  if (bank.edition !== "teacher" || !bank.papers?.length || !bank.images) throw new Error("请选择 MAP 本地老师版。");
  const ids = new Set();
  return bank.papers.map(paper => {
    const grade = Number(paper.grade);
    if (!Number.isInteger(grade) || grade < 1 || grade > 12) throw new Error("原卷需标明 Grade 1–12 中的一个年级。");
    if (!paper.id || ids.has(paper.id) || !paper.questions?.length || paper.questions.length > 100) {
      throw new Error("原卷编号或题数不合要求。");
    }
    ids.add(paper.id);
    const questions = new Set();
    for (const q of paper.questions) {
      if (!q.id || questions.has(q.id) || !Array.isArray(q.key) || typeof q.explanation !== "string"
        || !Array.isArray(q.terms) || !Array.isArray(q.notes) || !q.key.every(label => q.options.some(([option]) => option === label))) {
        throw new Error("原卷缺少正确的题目编号、答案或解析。");
      }
      questions.add(q.id);
    }
    const fragments = [paper.instructions, ...Object.values(paper.materials)];
    for (const q of paper.questions) fragments.push(q.stem, ...q.options.map(([, markup]) => markup));
    const imageIds = new Set(fragments.flatMap(markup => Array.from(markup.matchAll(/data-image="([^"]+)"/g), match => match[1])));
    const images = Object.fromEntries(Array.from(imageIds, id => {
      if (!/^data:image\/(?:png|webp);base64,/.test(bank.images[id])) throw new Error("原卷缺少题图 " + id);
      return [id, bank.images[id]];
    }));
    return { id: paper.id, paper: { ...paper, grade }, images };
  });
}

async function mountMapTeacher() {
  const get = id => document.getElementById(id);
  const login = get("teacher-login");
  const status = get("teacher-status");
  const workspace = get("teacher-workspace");
  if (!window.supabase) {
    status.textContent = "登录组件加载失败，请刷新页面。";
    return;
  }
  const client = window.supabase.createClient(MAP_CONFIG.url, MAP_CONFIG.key, {
    auth: { storageKey: "map-g6-teacher-session", detectSessionInUrl: false },
  });
  const paperCache = new Map();
  let papers = new Map();
  let worksheet = null;
  let classCode = "";
  let sessionId = null;
  let attempts = [];
  let selected = null;
  let rowLimit = 50;
  let loadNumber = 0;
  let gradeTarget = null;
  let realtime = null;
  let timer = null;
  let refreshSoon = null;

  function title(paper) {
    if (!paper) return "原卷";
    return "Grade " + paper.grade + " · " + paper.difficulty + " · " + paper.domain + " · " + paper.kind + " " + paper.number;
  }

  async function loadPaper(id) {
    if (!paperCache.has(id)) {
      paperCache.set(id, client.from("map_g6_papers").select("paper,images").eq("id", id).single().then(result => {
        if (result.error) throw result.error;
        return result.data;
      }).catch(error => {
        paperCache.delete(id);
        throw error;
      }));
    }
    return paperCache.get(id);
  }

  function currentMarks(record) {
    return record.question_ids.map((id, index) => record.grading?.[id]?.mark || record.marks?.[index]);
  }

  function score(record) {
    const marks = currentMarks(record);
    return marks.filter(mark => mark === "correct").length + " / " + marks.filter(mark => mark !== "unscored").length;
  }

  function showGrade(record, question) {
    gradeTarget = { record, question };
    const grading = record.grading?.[question.id] || {};
    get("grade-title").textContent = record.student + " · 第 " + question.number + " 题";
    get("grade-mark").value = grading.mark || "";
    get("grade-note").value = grading.note || "";
    get("grade-status").textContent = "";
    get("grade-dialog").showModal();
  }

  function overlay(question) {
    const index = selected?.question_ids.indexOf(question.id) ?? -1;
    if (index < 0) return null;
    const record = selected;
    const grading = record.grading?.[question.id];
    const result = grading?.mark || record.marks?.[index];
    const box = mapElement("div", "", "map-question-review");
    box.append(mapElement("strong", record.student + " 原答 " + (record.answers[question.id] || "未答")));
    if (result) box.append(mapElement("span", " · " + mapMarks[result]));
    if (grading?.note) box.append(mapElement("p", grading.note, "map-note"));
    if (record.submitted_at) box.append(mapButton(grading ? "修改批改" : "批改本题", () => showGrade(record, question)));
    return box;
  }

  function updateSelected(next) {
    const previous = selected;
    selected = next;
    get("selected-attempt").hidden = !next;
    if (next) {
      const answered = Object.keys(next.answers).length;
      get("selected-summary").textContent = next.student + " · " + title(papers.get(next.paper_id))
        + " · " + (next.submitted_at ? "已交卷 · " + score(next) + " 分" : "作答中 · " + answered + " / " + next.question_ids.length + " 题");
    }
    if (previous?.id !== next?.id || previous?.revision !== next?.revision || previous?.graded_at !== next?.graded_at) {
      worksheet?.refreshOverlay();
    }
  }

  function renderAttempts() {
    const rows = attempts.map(record => {
      const row = document.createElement("tr");
      const action = document.createElement("td");
      const button = mapButton("在讲义中看", () => {
        updateSelected(record);
        worksheet?.open(record.paper_id);
        get("selected-attempt").scrollIntoView({ block: "start" });
      });
      button.setAttribute("aria-label", "在讲义中看 " + record.student + " 的作答");
      action.append(button);
      const progress = Object.keys(record.answers).length + " / " + record.question_ids.length + " 题";
      for (const text of [
        record.student, title(papers.get(record.paper_id)),
        record.submitted_at ? "已交卷 · " + score(record) + " 分" : "作答中 · " + progress,
        mapClock.format(new Date(record.updated_at)),
      ]) row.append(mapElement("td", text));
      row.append(action);
      return row;
    });
    get("attempt-rows").replaceChildren(...rows);
    get("attempt-table").hidden = !rows.length;
    get("attempt-empty").hidden = Boolean(rows.length);
    get("more-attempts").hidden = rows.length < rowLimit || rowLimit >= 500;
  }

  async function refreshAttempts() {
    if (!sessionId || !classCode) return;
    const request = ++loadNumber;
    let query = client.from("map_g6_attempts").select(mapAttemptColumns)
      .order("updated_at", { ascending: false }).order("id").limit(rowLimit);
    const student = get("filter-student").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    const state = get("filter-state").value;
    if (student) query = query.like("student", student + "%");
    if (state === "live") query = query.is("submitted_at", null);
    if (state === "submitted") query = query.not("submitted_at", "is", null);
    const { data, error } = await query;
    if (request !== loadNumber || !sessionId) return;
    if (error) {
      get("attempt-status").textContent = "读取作答失败。" + mapMessage(error);
      return;
    }
    attempts = data || [];
    renderAttempts();
    if (selected) {
      const selectedId = selected.id;
      let fresh = attempts.find(record => record.id === selectedId);
      if (!fresh) {
        const result = await client.from("map_g6_attempts").select(mapAttemptColumns).eq("id", selectedId).maybeSingle();
        if (request !== loadNumber || !sessionId) return;
        if (!result.error) fresh = result.data;
      }
      if (fresh && selected?.id === selectedId) updateSelected(fresh);
    }
    get("attempt-status").textContent = (attempts.length ? "已读取 " + attempts.length + " 条" : "暂无记录")
      + " · " + mapClock.format(new Date()) + " 更新";
  }

  function scheduleRefresh() {
    if (refreshSoon) return;
    refreshSoon = setTimeout(() => {
      refreshSoon = null;
      refreshAttempts();
    }, 350);
  }

  async function loadCatalog() {
    const { data, error } = await client.rpc("map_g6_catalog", { p_class_code: classCode });
    if (error) throw error;
    papers = new Map(data.map(paper => [paper.id, paper]));
    get("import-summary").textContent = data.length
      ? "导入题库 · 已有 " + data.length + " 份原卷"
      : "首次使用 · 请导入本地老师版";
    get("teacher-worksheet").hidden = !data.length;
    get("share-entry").disabled = !data.length;
    get("share-paper").disabled = !data.length;
    if (data.length && !worksheet) {
      worksheet = startMapWorksheet({ papers: data, images: {} }, loadPaper, overlay, () => updateSelected(null));
    } else if (data.length) {
      worksheet.setCatalog(data);
    } else {
      get("import-bank").open = true;
    }
  }

  async function openWorkspace(session) {
    if (!session?.user || session.user.id === sessionId) return;
    const { data: allowed, error } = await client.rpc("is_teacher");
    if (error || allowed !== true) {
      await client.auth.signOut({ scope: "local" });
      status.textContent = error ? mapMessage(error) : "这个账号没有 MAP 老师权限。";
      return;
    }
    sessionId = session.user.id;
    login.hidden = true;
    workspace.hidden = false;
    status.textContent = "";
    get("teacher-who").textContent = session.user.email || "老师";
    try {
      const { data: settings, error: settingsError } = await client.from("map_g6_class").select("class_code").single();
      if (settingsError) throw settingsError;
      classCode = settings.class_code;
      await loadCatalog();
      await refreshAttempts();
      realtime = client.channel("map-g6-attempts")
        .on("postgres_changes", { event: "*", schema: "public", table: "map_g6_attempts" }, scheduleRefresh)
        .subscribe();
      timer = setInterval(() => {
        if (!document.hidden) refreshAttempts();
      }, 8000);
      window.addEventListener("focus", scheduleRefresh);
    } catch (loadError) {
      status.textContent = mapMessage(loadError);
    }
  }

  get("teacher-login-form").onsubmit = async event => {
    event.preventDefault();
    const password = get("teacher-password");
    const submit = get("teacher-sign-in");
    submit.disabled = true;
    status.textContent = "正在登录…";
    try {
      const { data, error } = await client.auth.signInWithPassword({
        email: get("teacher-email").value.trim(), password: password.value,
      });
      if (error) throw error;
      password.value = "";
      await openWorkspace(data.session);
    } catch (error) {
      status.textContent = mapMessage(error);
    } finally {
      submit.disabled = false;
    }
  };

  get("teacher-sign-out").onclick = async () => {
    const { error } = await client.auth.signOut({ scope: "local" });
    if (error) status.textContent = mapMessage(error);
    else location.reload();
  };

  get("import-form").onsubmit = async event => {
    event.preventDefault();
    if (!classCode) return;
    const file = get("bank-file").files[0];
    if (!file) return;
    const button = get("import-button");
    const message = get("import-status");
    button.disabled = true;
    message.textContent = "正在核对本地题库…";
    try {
      const rows = mapReadBank(await file.text()).filter(row => {
        const existing = papers.get(row.id);
        if (existing && Number(existing.grade) !== row.paper.grade) throw new Error("不同年级的原卷编号需要区分。");
        return !existing;
      });
      const { data: latest, error: seqError } = await client.from("map_g6_papers").select("seq")
        .order("seq", { ascending: false }).limit(1);
      if (seqError) throw seqError;
      const firstSeq = (latest[0]?.seq ?? 0) + 1;
      for (const [index, row] of rows.entries()) {
        message.textContent = "导入原卷 " + (index + 1) + " / " + rows.length + "…";
        const { error } = await client.from("map_g6_papers").upsert({ ...row, seq: firstSeq + index }, { onConflict: "id", ignoreDuplicates: true });
        if (error) throw error;
      }
      await loadCatalog();
      message.textContent = "题库已就绪，共 " + papers.size + " 份原卷、"
        + [...papers.values()].reduce((total, paper) => total + paper.questions.length, 0) + " 道题。";
      get("bank-file").value = "";
      await refreshAttempts();
    } catch (error) {
      message.textContent = "导入暂停。" + mapMessage(error) + " 可以选择同一文件重试，已导入的原卷会保留。";
    } finally {
      button.disabled = false;
    }
  };

  async function share(paperId = "") {
    const url = new URL("./", location.href);
    const params = new URLSearchParams({ class: classCode });
    if (paperId) params.set("paper", paperId);
    url.hash = params.toString();
    const fallback = get("share-link");
    fallback.hidden = false;
    fallback.value = url.href;
    try {
      await navigator.clipboard.writeText(url.href);
      get("share-status").textContent = "学生链接已复制";
    } catch {
      fallback.focus();
      fallback.select();
      get("share-status").textContent = "请复制选中的学生链接";
    }
  }

  get("share-entry").onclick = () => share();
  get("share-paper").onclick = () => share(worksheet?.activeId());
  get("clear-attempt").onclick = () => updateSelected(null);
  get("refresh-attempts").onclick = refreshAttempts;
  get("filter-state").onchange = () => { rowLimit = 50; refreshAttempts(); };
  get("filter-student").oninput = () => { rowLimit = 50; scheduleRefresh(); };
  get("more-attempts").onclick = () => { rowLimit += 50; refreshAttempts(); };

  get("grade-form").onsubmit = async event => {
    event.preventDefault();
    const { record, question } = gradeTarget;
    const button = get("save-grade");
    const message = get("grade-status");
    const note = get("grade-note").value.trim();
    const mark = get("grade-mark").value;
    const grading = { ...record.grading };
    if (note || mark) grading[question.id] = { note, mark };
    else delete grading[question.id];
    const gradedAt = new Date(Math.max(Date.now(), (Date.parse(record.graded_at) || 0) + 1)).toISOString();
    button.disabled = true;
    message.textContent = "正在保存…";
    try {
      let query = client.from("map_g6_attempts").update({ grading, graded_at: gradedAt }).eq("id", record.id);
      query = record.graded_at ? query.eq("graded_at", record.graded_at) : query.is("graded_at", null);
      const { data, error } = await query.select(mapAttemptColumns).maybeSingle();
      if (error) throw error;
      if (!data) {
        await refreshAttempts();
        throw new Error("这份批改刚刚在另一处更新。请复制当前文字，关闭后重新打开本题再保存。");
      }
      get("grade-dialog").close();
      if (selected?.id === data.id) updateSelected(data);
      await refreshAttempts();
    } catch (error) {
      message.textContent = mapMessage(error);
    } finally {
      button.disabled = false;
    }
  };
  get("cancel-grade").onclick = () => get("grade-dialog").close();

  client.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT" && sessionId && !session) {
      workspace.hidden = true;
      clearInterval(timer);
      if (realtime) client.removeChannel(realtime);
      location.reload();
    }
  });
  const { data, error } = await client.auth.getSession();
  if (error) status.textContent = mapMessage(error);
  else if (data.session) await openWorkspace(data.session);
}
