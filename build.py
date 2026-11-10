"""Build the GitHub Pages entries from the local MAP templates."""

import argparse
import base64
import hashlib
import html
import json
import re
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT.parent / "practice_src"
SITE = ROOT / "docs"


def read(path):
    return path.read_text(encoding="utf-8")


def swap(text, before, after):
    if text.count(before) != 1:
        raise ValueError(f"Local template changed at {before[:85]!r}")
    return text.replace(before, after, 1)


def replace_function(source, name, replacement):
    pattern = rf"^function {name}\([^\n]*\) \{{\n.*?^\}}\n"
    source, count = re.subn(pattern, lambda _: replacement.strip() + "\n" if replacement else "", source, flags=re.M | re.S)
    if count != 1:
        raise ValueError(f"Local function changed: {name}")
    return source


STUDENT_GATE = """
    <section id="join-view" class="map-card map-gate" aria-labelledby="join-title">
      <p class="kicker">MAP GRADE 6</p>
      <h1 id="join-title">进入在线练习</h1>
      <p class="map-muted">使用老师发来的链接或班级码，填写姓名拼音缩写即可开始。</p>
      <form id="join-form" class="map-form">
        <label>姓名拼音缩写 <input id="student-name" maxlength="16" placeholder="例如 HQ" autocapitalize="characters" required></label>
        <label>班级码 <input id="class-code" maxlength="36" autocomplete="off" spellcheck="false" required></label>
        <button class="map-button map-primary" id="join-button" type="submit">进入题库</button>
      </form>
      <p id="join-status" class="map-status" role="status"></p>
    </section>
    <p id="sync-status" class="map-status" role="status"></p>
    <div id="practice-app" hidden>
"""

TEACHER_WORKSPACE = """
    <section id="teacher-login" class="map-card map-gate">
      <h1>老师登录</h1>
      <p class="map-muted">使用 DET 作答记录的老师账号。</p>
      <form id="teacher-login-form" class="map-form">
        <label>邮箱 <input id="teacher-email" type="email" autocomplete="username" required></label>
        <label>密码 <input id="teacher-password" type="password" autocomplete="current-password" required></label>
        <button class="map-button map-primary" id="teacher-sign-in" type="submit">登录</button>
      </form>
    </section>
    <p id="teacher-status" class="map-status" role="status"></p>
    <div id="teacher-workspace" hidden>
      <section class="map-card">
        <div class="map-toolbar">
          <strong id="teacher-who"></strong>
          <button class="map-button" id="share-entry" disabled>复制学生链接</button>
          <button class="map-button" id="share-paper" disabled>复制当前原卷链接</button>
          <button class="map-button" id="teacher-sign-out">退出</button>
        </div>
        <input id="share-link" class="map-share" aria-label="学生链接" readonly hidden>
        <p id="share-status" class="map-status" role="status"></p>
        <details id="import-bank">
          <summary id="import-summary">题库导入</summary>
          <form id="import-form" class="map-form">
            <label>选择 MAP_本地练习_老师版.html <input id="bank-file" type="file" accept=".html,text/html" required></label>
            <button class="map-button map-primary" id="import-button" type="submit">导入 Supabase</button>
          </form>
          <p id="import-status" class="map-status" role="status"></p>
        </details>
      </section>
      <section class="map-card" aria-labelledby="attempt-title">
        <h2 id="attempt-title">实时作答</h2>
        <div class="map-toolbar">
          <label>学生缩写 <input id="filter-student" type="search" maxlength="16"></label>
          <label>状态 <select id="filter-state"><option value="">全部</option><option value="live">作答中</option><option value="submitted">已交卷</option></select></label>
          <button class="map-button" id="refresh-attempts">刷新</button>
        </div>
        <p id="attempt-status" class="map-status" role="status"></p>
        <p id="attempt-empty" class="map-muted" hidden>这个筛选范围内暂无作答。</p>
        <div class="map-table-wrap">
          <table id="attempt-table" class="map-table" hidden>
            <thead><tr><th scope="col">学生</th><th scope="col">原卷</th><th scope="col">进度／分数</th><th scope="col">更新时间</th><th scope="col">操作</th></tr></thead>
            <tbody id="attempt-rows"></tbody>
          </table>
        </div>
        <button class="map-button" id="more-attempts" hidden>显示更多作答</button>
      </section>
      <section id="selected-attempt" class="map-card map-toolbar" hidden>
        <strong id="selected-summary"></strong>
        <button class="map-button" id="clear-attempt">返回纯讲义</button>
      </section>
      <div id="teacher-worksheet" hidden>
        <p id="worksheet-status" class="map-status" role="status"></p>
"""

GRADE_DIALOG = """
  <dialog id="grade-dialog" class="map-dialog" aria-labelledby="grade-title">
    <form id="grade-form" class="map-form">
      <h2 id="grade-title"></h2>
      <p class="map-muted">批改仅老师可见。投屏时可在讲义里展示点评。</p>
      <label>本题判定
        <select id="grade-mark">
          <option value="">沿用自动判定</option><option value="correct">算对</option>
          <option value="incorrect">算错</option><option value="unscored">不计分</option>
        </select>
      </label>
      <label>讲解点评 <textarea id="grade-note" rows="5" maxlength="2000"></textarea></label>
      <p id="grade-status" class="map-status" role="status"></p>
      <div class="map-toolbar">
        <button id="save-grade" class="map-button map-primary" type="submit">保存批改</button>
        <button id="cancel-grade" class="map-button" type="button">取消</button>
      </div>
    </form>
  </dialog>
"""


def student_template():
    template = read(SOURCE / "practice.template.html")
    template = swap(template, "<span>MAP 本地练习</span>", "<span>MAP Grade 6 在线练习</span>")
    template = swap(template, '<nav class="site-nav" aria-label="主要导航">', '<nav id="student-controls" class="site-nav" aria-label="主要导航" hidden>')
    template = swap(template, '<button id="nav-history" type="button">练习记录</button>', '<button id="nav-history" type="button">练习记录</button><button id="change-student" type="button">更换学生</button>')
    template = swap(template, "  <main>\n", "  <main>\n" + STUDENT_GATE)
    template = swap(template, "  </main>", '    </div>\n    <footer class="map-footer"><a href="作答记录-老师登录版本.html">老师入口</a></footer>\n  </main>')
    template = swap(template, "作答进度和练习记录保存在当前浏览器。", "作答进度自动同步给老师。使用当前浏览器继续上次练习。")
    return swap(template, "这里显示当前浏览器中这份 HTML 的练习记录。", "这里显示当前学生在这个浏览器中的练习记录。")


def student_script():
    source = read(SOURCE / "practice.js")
    source = swap(source, 'const bank = JSON.parse(document.getElementById("practice-bank").textContent);\nconst teacherEdition = bank.edition === "teacher";\n', "")
    source = swap(source, "const prefix = `map-local-practice-v1:${bank.edition}:`;", "const prefix = `map-g6-v1:${cloud.classCode}:${student}:`;")
    source = swap(source, "const encoder = new TextEncoder();\n", "")
    source = swap(source, "let active = null;", "let active = null;\nlet opening = 0;\nlet finishing = false;")
    source = swap(source, 'function showView(name) {\n', 'function showView(name) {\n  if (name !== "quiz") { opening += 1; cloud.show(null); }\n')
    source = swap(source, 'id: now.toString(36) + "-" + Math.random().toString(36).slice(2),', "id: crypto.randomUUID(),\n    token: crypto.randomUUID(),\n    revision: 0,")
    source = replace_function(source, "saveAttempt", """
function saveAttempt(record) {
  record.revision += 1;
  save("attempt:" + record.id, record);
  cloud.save(record);
}
""")
    source = swap(source, "function openAttempt(record) {\n  const paper = papers.get(record.paperId);", """
async function openAttempt(record) {
  const request = ++opening;
  const status = get("sync-status");
  status.textContent = "正在加载原卷…";
  let paper;
  try {
    const result = await cloud.paper(record.paperId);
    if (request !== opening) return;
    paper = result.paper;
    Object.assign(bank.images, result.images);
    papers.set(paper.id, paper);
  } catch (error) {
    if (request === opening) status.textContent = mapMessage(error);
    return;
  }
""".strip())
    source = swap(source, '  showView("quiz");\n  renderQuiz();', '  showView("quiz");\n  cloud.show(record);\n  if (!record.submittedAt && !record.submitRequested) cloud.save(record);\n  renderQuiz();')
    source = replace_function(source, "answerMark", "")
    source = replace_function(source, "renderTeacher", "")
    source = swap(source, '  renderTeacher(question, reviewed);\n', "")
    source = swap(source, '    input.disabled = reviewed;', '    input.disabled = reviewed || Boolean(record.submitRequested);')
    source = swap(source, '    if (reviewed && teacherEdition && question.key.includes(label)) row.classList.add("teacher-key");\n    if (!reviewed) {', '    if (!input.disabled) {')
    source = swap(source, '  if (!active.record.submittedAt) {', '  if (!active.record.submittedAt && !active.record.submitRequested) {')
    source = swap(source, '  get("submit-quiz").hidden = reviewed;', '''
  get("submit-quiz").hidden = reviewed;
  get("submit-quiz").disabled = finishing;
  get("submit-quiz").textContent = record.submitRequested ? "重试交卷" : "交卷";'''.lstrip("\n"))
    source = replace_function(source, "finishAttempt", """
async function finishAttempt() {
  const { record } = active;
  if (record.submittedAt || finishing) return;
  if (!record.submitRequested) {
    record.submitRequested = true;
    record.revision += 1;
    save("attempt:" + record.id, record);
  }
  finishing = true;
  renderQuiz();
  try {
    const result = await cloud.submit(record);
    record.marks = result.marks;
    record.submittedAt = Date.parse(result.submitted_at);
    record.updatedAt = record.submittedAt;
    delete record.submitRequested;
    save("attempt:" + record.id, record);
    if (active.record.id === record.id) {
      active.record = record;
      active.index = 0;
      setNumberGrid(true);
    }
  } catch {
    // Keep the same attempt ID and revision so an unacknowledged submit can be retried.
  } finally {
    finishing = false;
    if (!get("quiz-view").hidden) renderQuiz();
    else if (!get("history-view").hidden) showHistory();
  }
}
""")
    source = swap(source, "function requestFinish() {\n", "function requestFinish() {\n  if (finishing) return;\n  if (active.record.submitRequested) { finishAttempt(); return; }\n")
    source = swap(source, '  const record = saved || newAttempt(paper, set);\n  saveAttempt(record);', '  const record = saved || newAttempt(paper, set);\n  if (!saved) saveAttempt(record);')
    source = swap(source, 'document.body.dataset.edition = bank.edition;\nget("edition").textContent = teacherEdition ? "老师版" : "学生版";', '''
const linkedPaper = papers.get(initialPaperId);
if (linkedPaper) Object.assign(selection, {
  subject: linkedPaper.subject,
  grade: String(linkedPaper.grade),
  difficulty: linkedPaper.difficulty,
  paper: linkedPaper.id,
  range: "0",
});'''.strip())
    return "function startMapPractice(bank, cloud, student, initialPaperId) {\n" + source + "}\nmountMapStudent();"


def teacher_template():
    template = read(SOURCE / "teacher.template.html")
    template = swap(template, "MAP 教师讲义", "MAP Grade 6 作答与讲义")
    template = swap(template, "  <main>\n", "  <main>\n" + TEACHER_WORKSPACE)
    return swap(template, "  </main>", '      </div>\n    </div>\n    <footer class="map-footer"><a href="./">学生入口</a></footer>\n  </main>\n' + GRADE_DIALOG)


def teacher_script():
    source = read(SOURCE / "teacher.js")
    source = swap(source, 'const bank = JSON.parse(document.getElementById("practice-bank").textContent);\n', "")
    source = swap(source, "const defaultPaper =", "let defaultPaper =")
    source = swap(source, "    activePaper = paper;\n    location.hash = paper.id;", "    onPaperChange();\n    activePaper = paper;\n    location.hash = paper.id;")
    source = swap(source, '  row.append(stem, optionCell, explanation);', '  explanation.append(node("div", "map-overlay"));\n  row.append(stem, optionCell, explanation);')
    source = swap(source, '  get("worksheet-rows").replaceChildren(sheet);', '  get("worksheet-rows").replaceChildren(sheet);\n  renderedPaper = paper;\n  refreshOverlay();')
    source = swap(source, '  get("instructions").hidden = !activePaper.instructions;\n  rich(get("instructions"), activePaper.instructions);\n  renderWorksheet(activePaper);', '  showWorksheet(activePaper.id);')
    source = swap(source, "  if (paper.id !== activePaper.id) {\n    activePaper = paper;\n    render();", "  if (paper.id !== activePaper.id) {\n    onPaperChange();\n    activePaper = paper;\n    render();")
    source = source[:source.index('get("bank-total").textContent =')]
    source += """
let renderedPaper = null;
let loading = 0;

function refreshOverlay() {
  for (const question of renderedPaper?.questions || []) {
    const holder = get("question-" + question.number).querySelector(".map-overlay");
    const content = overlay(question);
    holder.replaceChildren(...(content ? [content] : []));
  }
}

async function showWorksheet(id) {
  const request = ++loading;
  const message = get("worksheet-status");
  message.textContent = "正在加载讲义…";
  get("instructions").hidden = true;
  get("worksheet-rows").replaceChildren();
  renderedPaper = null;
  try {
    const { paper, images } = await loadPaper(id);
    if (request !== loading) return;
    Object.assign(bank.images, images);
    get("instructions").hidden = !paper.instructions;
    rich(get("instructions"), paper.instructions);
    renderWorksheet(paper);
    message.textContent = "";
  } catch (error) {
    if (request === loading) message.textContent = mapMessage(error);
  }
}

function setCatalog(catalog) {
  bank.papers = catalog;
  papers.clear();
  for (const paper of catalog) papers.set(paper.id, paper);
  defaultPaper = papers.get(defaultPaper.id) || catalog[0];
  activePaper = papers.get(activePaper.id) || defaultPaper;
  get("bank-total").textContent = catalog.length + " 份原卷 · "
    + catalog.reduce((sum, paper) => sum + paper.questions.length, 0) + " 道题";
  render();
}

setCatalog(bank.papers);
return {
  refreshOverlay,
  setCatalog,
  activeId: () => activePaper.id,
  open(id) {
    const paper = papers.get(id);
    if (!paper || id === activePaper.id) return;
    activePaper = paper;
    location.hash = paper.id;
    render();
  },
};
"""
    return "function startMapWorksheet(bank, loadPaper, overlay, onPaperChange) {\n" + source + "}\nmountMapTeacher();"


def public_config(det_page):
    match = re.search(r"supabase\.createClient\('(https://[^']+)','(eyJ[^']+)'\)", read(det_page))
    if not match:
        raise ValueError("Cannot find the public Supabase connection in the DET page.")
    url, key = match.groups()
    payload = key.split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    parts = urlsplit(url)
    if claims.get("role") != "anon" or not re.fullmatch(r"[a-z0-9.-]+", parts.netloc) or parts.path:
        raise ValueError("Only the browser-safe DET anon connection is supported.")
    return {"url": url, "key": key}


def build(filename, name, title, template, script, config):
    script = '"use strict";\nconst MAP_CONFIG = ' + json.dumps(config) + ";\n" + script
    digest = base64.b64encode(hashlib.sha256(script.encode("utf-8")).digest()).decode("ascii")
    teacher = name == "teacher"
    csp = (
        f"default-src 'none'; script-src 'self' 'sha256-{digest}' https://cdn.jsdelivr.net; "
        f"connect-src {config['url']} {config['url'].replace('https:', 'wss:', 1)}; "
        "style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'"
    )
    head = f'  <meta http-equiv="Content-Security-Policy" content="{html.escape(csp, quote=True)}">\n'
    head += '  <meta name="referrer" content="no-referrer">\n  <link rel="stylesheet" href="cloud.css">\n'
    template = swap(template, "  <title>", head + "  <title>")
    template = swap(template, "@@STYLE@@", read(SOURCE / f"{name}.css"))
    template = swap(template, "@@TITLE@@", title)
    loader = ""
    if teacher:
        loader = (
            '  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.89.0/dist/umd/supabase.js" '
            'integrity="sha384-sddcMIX7Ar6auuLM3TihDPYO6uOeMYsjtmZKfi8V83eeqdFWdnpAtk90odEwbXjh" crossorigin="anonymous"></script>\n'
        )
    loader += '  <script src="cloud.js"></script>\n'
    loader += f'  <script src="{"teacher" if teacher else "student"}-cloud.js"></script>'
    template = swap(template, '  <script id="practice-bank" type="application/json">@@BANK@@</script>', loader)
    template = swap(template, "@@SCRIPT@@", script)
    (SITE / filename).write_text(template, encoding="utf-8", newline="\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--det-page", type=Path, required=True, help="Path to the existing DET wp.html")
    config = public_config(parser.parse_args().det_page)
    build("index.html", "practice", "MAP Grade 6 在线练习", student_template(), student_script(), config)
    build("作答记录-老师登录版本.html", "teacher", "MAP Grade 6 作答记录 · 老师登录版本", teacher_template(), teacher_script(), config)
