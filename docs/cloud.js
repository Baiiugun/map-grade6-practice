"use strict";

function mapGradeOptions(papers) {
  const available = papers ? new Set(papers.map(paper => String(paper.grade))) : null;
  return Array.from({ length: 12 }, (_, index) => {
    const value = String(index + 1);
    const suffix = available && !available.has(value) ? "（暂无题库）" : "";
    return [value, "Grade " + value + suffix];
  });
}

function mapMessage(error) {
  const text = String(error?.message || error || "");
  if (error?.code === "PGRST202" || error?.code === "PGRST205" || error?.code === "42P01") {
    return "在线题库正在初始化。请老师在 Supabase 运行 setup.sql 后再试。";
  }
  if (text.includes("MAP_CLASS_CODE")) return "班级码不正确，请检查老师发来的链接。";
  if (text.includes("MAP_ATTEMPT_CHANGED")) return "另一处已更新这份作答，请回到原来的答题页面。";
  if (text.includes("MAP_ATTEMPT_OWNER")) return "无法验证这份作答，请回到开始练习时的浏览器。";
  if (text.includes("MAP_INVALID")) return "作答与题库不匹配，请联系老师核对。";
  if (/invalid login credentials/i.test(text)) return "邮箱或密码不正确。";
  if (/failed to fetch|networkerror/i.test(text)) return "暂时无法连接 Supabase，请检查网络后重试。";
  return text || "操作失败，请重试。";
}

function mapElement(tag, text = "", className = "") {
  const item = document.createElement(tag);
  item.textContent = text;
  item.className = className;
  return item;
}

function mapButton(label, action) {
  const button = mapElement("button", label, "map-button");
  button.type = "button";
  button.addEventListener("click", action);
  return button;
}

function mapReadLocal(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

function mapWriteLocal(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The exercise page reports when local storage is unavailable.
  }
}

async function mapPublicRpc(name, args, keepalive = false) {
  const response = await fetch(MAP_CONFIG.url + "/rest/v1/rpc/" + name, {
    method: "POST",
    headers: {
      apikey: MAP_CONFIG.key,
      Authorization: "Bearer " + MAP_CONFIG.key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
    keepalive,
  });
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    throw Object.assign(new Error(details.message || "请求失败，HTTP " + response.status), { code: details.code });
  }
  return response.json();
}

// Restore notation in translations already stored in the question bank.
function mapReadingChoiceNotation(paper) {
  if (paper?.locale !== "zh-CN") return paper;

  const letters = "甲乙丙丁";
  const restoreLetters = text => text.replace(/[甲乙丙丁]/g, label => "ABCD"[letters.indexOf(label)]);
  const items = /(<br\s*\/?>)([甲乙丙丁戊])[、．.]/g;
  const restoreRoman = label => ["i", "ii", "iii", "iv", "v"]["甲乙丙丁戊".indexOf(label)];
  const before = /(?:^|[，。、；：:“‘「（(→✓\s]|(?:选项|答案(?:字母)?(?:标为|是|为)?|支持|对应|选择|选的是|选|排除|对比|比较|不是|已知|认为|觉得|以为|肯定|还有|分别为|不如|比|按)\s*)/;
  const labels = /[甲乙丙丁](?:[、和或与][甲乙丙丁])*/;
  const after = /(?=$|项|选项|[，。；、：“‘”’」）)（(！？?!…\s]|都|也|更|较|最|只|没|是|把|正确|不|很|能|看|先|错|三个|三项|两项|判分|全|明确|提示|直接|中|里|讲|写)/;
  const references = new RegExp("(" + before.source + ")(" + labels.source + ")" + after.source, "g");

  return {
    ...paper,
    questions: paper.questions.map(question => {
      const { stem, options } = question;
      const isRhymeScheme = stem.includes("押韵") && options.every(([, text]) => /^[甲乙丙丁]{4}$/.test(text));
      const hasRomanItems = Array.from(stem.matchAll(items), match => match[2]).join("") === "甲乙丙丁戊";
      const restoreScheme = text => isRhymeScheme
        ? text.replace(/[甲乙丙丁]{2,}|(?<=从)[甲乙丙丁](?=开始)/g, restoreLetters)
        : text;
      const display = {
        ...question,
        stem: hasRomanItems ? stem.replace(items, (_, br, label) => br + restoreRoman(label) + ". ") : stem,
        options: options.map(([label, text]) => [
          label,
          hasRomanItems && /^[甲乙丙丁戊](?:[、和或与][甲乙丙丁戊])+$/.test(text)
            ? text.replace(/[甲乙丙丁戊]/g, restoreRoman)
            : restoreScheme(text),
        ]),
      };
      if (typeof question.explanation !== "string") return display;
      const restoreReferences = text => restoreScheme(text)
        .replace(references, (_, prefix, marks) => prefix + restoreLetters(marks))
        .replace(/[甲乙丙丁](?=项(?!目))/g, restoreLetters);
      display.explanation = restoreReferences(question.explanation);
      display.notes = question.notes.map(restoreReferences);
      display.terms = question.terms.map(([text, role]) => [restoreScheme(text), role]);
      if (question.skills) {
        display.skills = Object.fromEntries(Object.entries(question.skills).map(([field, value]) => [
          field,
          field === "standard" ? value : Array.isArray(value) ? value.map(restoreReferences) : restoreReferences(value),
        ]));
      }
      return display;
    }),
  };
}
