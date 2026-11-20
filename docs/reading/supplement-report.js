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
      const [first, last] = Array.isArray(data.choices?.[id]) ? data.choices[id] : [];
      const previous = group.questions.get(id);
      if (!previous) { group.questions.set(id, [...answer, first, last]); continue; }
      if (answer[0] < previous[0] || (answer[0] === previous[0] && previous[4] == null)) {
        [previous[0], previous[1], previous[4]] = [answer[0], answer[1], first];
      }
      if (answer[2] > previous[2] || (answer[2] === previous[2] && previous[5] == null)) {
        [previous[2], previous[3], previous[5]] = [answer[2], answer[3], last];
      }
    }
  }
  return [...groups.values()].sort((a, b) => b.latest.at - a.latest.at);
}

async function loadSupplementBook() {
  const response = await fetch("reading/supplement-zh.html");
  if (!response.ok) throw new Error("HTTP " + response.status);
  const source = new DOMParser().parseFromString(await response.text(), "text/html");
  const book = JSON.parse(source.getElementById("book-data").textContent);
  return {
    pages: new Map(book.passages.map(p => [p.id, p])),
    questions: new Map(book.questions.map(q => [q.id, q])),
  };
}

function supplementCurrentQuestion(book, d) {
  if (d.qid || !d.skill || !d.pos) return book.questions.get(d.qid);
  // Earlier clients saved the skill, the scope size, the position and the Chinese titles.
  const pool = [...book.questions.values()].filter(q => q.skill === d.skill);
  const matches = new Set();
  for (const family of ["all", "lit", "info"]) {
    const scope = pool.filter(q => family === "all" || q.pages.some(id => book.pages.get(id)?.family === family));
    const q = scope[d.pos - 1];
    if (scope.length === d.count && q && q.pages.map(id => book.pages.get(id)?.title[1]).join(" / ") === d.passage) matches.add(q);
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}

function renderSupplementDetail(target, book, group, selectedId) {
  const d = group.latest;
  const lang = d.lang === "en" ? 0 : 1;
  const current = supplementCurrentQuestion(book, d);
  const q = selectedId ? book.questions.get(selectedId) : current;
  const page = book.pages.get(d.page) || (current?.pages.length === 1 ? book.pages.get(current.pages[0]) : null)
    || [...book.pages.values()].find(p => p.title[1] === d.passage);
  const nodes = document.createDocumentFragment();
  const field = (label, value, cls = "") => {
    const line = mapElement("p", "", cls);
    line.append(mapElement("strong", label + "　"), document.createTextNode(value));
    nodes.append(line);
  };
  const title = p => p.title[lang];
  const active = Date.now() - d.at < 90000 && ["reading", "working"].includes(d.state);
  field(active ? "当前篇目" : "最近篇目", page ? title(page) : d.passage || "尚未打开篇目");
  if (page) {
    const link = mapElement("a", "打开篇目原文 ↗");
    link.href = "reading/supplement-" + d.lang + ".html#" + d.lang + "/sources/" + encodeURIComponent(page.id);
    link.target = "_blank";
    link.rel = "noopener";
    nodes.append(link);
  }
  if (q) {
    const hist = group.questions.get(q.id);
    const option = i => Number.isInteger(i) && q.o[i] ? "ABCD"[i] + " · " + q.o[i][lang] : "旧记录未保存选项";
    const judge = ok => ok ? "正确" : "错误";
    const live = !selectedId && d.qid === q.id;
    field(selectedId ? "作答题目" : "当前题目", q.stem[lang], "reading-question");
    if (selectedId) field("所属篇目", q.pages.map(id => title(book.pages.get(id))).join(" / "));
    if (live && !d.submitted) {
      field("学生选择", d.choice == null ? "尚未选择" : option(d.choice));
      field("判定", "尚未提交");
    } else if (live && Number.isInteger(d.choice)) {
      field("学生选择", option(d.choice));
      field("判定", judge(d.choice === q.key), d.choice === q.key ? "reading-right" : "reading-wrong");
    } else if (hist) {
      field("最近提交", option(hist[5]));
      field("判定", judge(hist[3]), hist[3] ? "reading-right" : "reading-wrong");
    } else {
      field("学生选择", "尚未收到本题选项");
      field("判定", "尚无提交记录");
    }
    if (hist && (hist[0] !== hist[2] || (live && !d.submitted))) {
      field("首次提交", option(hist[4]) + "（" + judge(hist[1]) + "）");
      if (live && !d.submitted && hist[0] !== hist[2]) field("最近提交", option(hist[5]) + "（" + judge(hist[3]) + "）");
    }
    field("正确答案", option(q.key));
    field("正确原因", q.why[1]);
    const list = mapElement("ul", "", "reading-evidence");
    for (const ev of q.ev) {
      const source = book.pages.get(ev.p);
      const part = source.parts.find(p => String(p.n) === String(ev.n));
      const text = lang === 1 ? part?.t[1] || ev.quote : ev.quote || part?.t[0];
      const locator = String(ev.n).startsWith("t") ? "表格第 " + String(ev.n).slice(1) + " 行"
        : Number.isInteger(ev.n) ? "第 " + ev.n + " 段" : String(ev.n);
      list.append(mapElement("li", title(source) + " · " + locator + "　" + text));
    }
    if (list.childElementCount) nodes.append(mapElement("strong", "原文依据"), list);
  } else if (d.state === "reading") {
    field("作答状态", active ? "正在阅读文章，尚未打开练习题。" : "最近停留在文章阅读页。");
  } else if (d.state === "selecting") {
    field("作答状态", "正在选择篇目或专项。");
  } else {
    field("作答状态", "等待学生页面同步具体题目。");
  }
  target.replaceChildren(nodes);
}

function watchSupplementReport(client) {
  const status = document.getElementById("supplement-status");
  const body = document.getElementById("supplement-rows");
  const table = document.getElementById("supplement-table");
  const filter = document.getElementById("supplement-filter");
  const panel = document.getElementById("reading-detail");
  const detail = document.getElementById("reading-detail-content");
  const picker = document.getElementById("reading-detail-question");
  let groups = [], busy = false, selected = "", book = null, bookError = false, lastDetail = "";
  const keyFor = d => JSON.stringify([d.student, d.lang]);

  function showDetail(group) {
    panel.hidden = !group;
    if (!group) return;
    const d = group.latest, key = keyFor(d);
    if (selected !== key) picker.replaceChildren();
    selected = key;
    document.getElementById("reading-detail-title").textContent = d.student + " · " + (d.lang === "zh" ? "中文翻译版" : "英文原版") + "阅读详情";
    if (!book) {
      detail.textContent = bookError ? "未能读取题库，请刷新阅读进度重试。" : "正在读取题目与解析…";
      return;
    }
    const answered = [...group.questions].filter(([id]) => book.questions.has(id)).sort((a, b) => b[1][2] - a[1][2]);
    const ids = JSON.stringify(answered.map(([id]) => id));
    if (!picker.options.length || picker.dataset.ids !== ids) {
      const previous = picker.value;
      picker.replaceChildren(new Option("跟随学生当前进度", ""));
      for (const [id] of answered) {
        const q = book.questions.get(id);
        picker.add(new Option(q.skill + " · " + q.stem[d.lang === "en" ? 0 : 1], id));
      }
      if (answered.some(([id]) => id === previous)) picker.value = previous;
      picker.dataset.ids = ids;
    }
    const displayed = picker.value || supplementCurrentQuestion(book, d)?.id;
    const detailState = JSON.stringify([key, picker.value, displayed, d.qid, d.page, d.passage, d.pos,
      d.state, d.choice, d.submitted, group.questions.get(displayed), Date.now() - d.at < 90000]);
    if (detailState !== lastDetail) {
      renderSupplementDetail(detail, book, group, picker.value);
      lastDetail = detailState;
    }
  }
  function render(preferred = selected) {
    const search = filter.value.trim().toLowerCase();
    const result = document.createDocumentFragment();
    const visible = groups.filter(g => g.latest.student.toLowerCase().includes(search));
    const chosen = visible.find(g => keyFor(g.latest) === preferred) || visible[0];
    for (const group of visible) {
      const { latest: d, questions } = group;
      const row = document.createElement("tr");
      const button = mapButton(d.student, () => {
        render(keyFor(d));
        document.getElementById("reading-detail-title").focus();
      });
      button.setAttribute("aria-label", "查看 " + d.student + (d.lang === "zh" ? " 中文版" : " 英文版") + "阅读详情");
      button.setAttribute("aria-pressed", String(group === chosen));
      const studentCell = mapElement("td");
      studentCell.append(button);
      row.append(studentCell);
      const answered = questions.size;
      const attempts = [...questions.values()];
      const first = attempts.filter(q => q[1]).length;
      const outstanding = attempts.filter(q => !q[3]).length;
      const states = { reading: "阅读", paused: "已暂停", finished: "专项已完成", working: "练习", selecting: "选择篇目或专项" };
      const progress = [states[d.state], d.skill, d.passage, d.count ? d.pos + "/" + d.count : ""].filter(Boolean).join(" · ");
      const correct = answered ? Math.round(first / answered * 100) + "%（" + first + "/" + answered + "）" : "—";
      for (const value of [d.lang === "zh" ? "中文翻译版" : "英文原版",
        answered + " / " + d.total, correct, outstanding, progress, new Date(d.at).toLocaleString()]) {
        row.append(mapElement("td", String(value)));
      }
      result.append(row);
    }
    body.replaceChildren(result);
    table.hidden = !body.children.length;
    status.textContent = table.hidden ? (search ? "没有匹配的学生。" : "尚未收到补充阅读进度。") : "";
    showDetail(chosen);
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
      if (groups.length && !book) {
        render();
        try { book = await loadSupplementBook(); bookError = false; }
        catch { bookError = true; }
      }
      render();
    } catch (error) {
      status.textContent = "未能刷新阅读进度。" + mapMessage(error);
    } finally { busy = false; }
  }
  filter.addEventListener("input", () => render());
  picker.onchange = () => showDetail(groups.find(g => keyFor(g.latest) === selected));
  document.getElementById("supplement-refresh").onclick = refresh;
  refresh();
  const timer = setInterval(() => { if (!document.hidden) refresh(); }, 5000);
  window.addEventListener("focus", refresh);
  return () => { clearInterval(timer); window.removeEventListener("focus", refresh); };
}
