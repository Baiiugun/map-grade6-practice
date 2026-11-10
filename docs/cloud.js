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
