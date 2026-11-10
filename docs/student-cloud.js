"use strict";

function mapStudentCloud(classCode, student) {
  const queues = new Map();
  const loaded = new Map();
  const statuses = new Map();
  const status = document.getElementById("sync-status");
  let visibleId = null;

  function report(id, message) {
    statuses.set(id, message);
    if (id === visibleId) status.textContent = message;
  }

  function rpc(name, args = {}, keepalive = false) {
    return mapPublicRpc(name, { p_class_code: classCode, ...args }, keepalive);
  }

  function payload(record, submit) {
    return {
      p_id: record.id,
      p_token: record.token,
      p_student: student,
      p_paper_id: record.paperId,
      p_question_ids: record.questionIds,
      p_answers: { ...record.answers },
      p_revision: record.revision,
      p_submit: submit,
    };
  }

  function schedule(queue, delay) {
    clearTimeout(queue.timer);
    queue.timer = setTimeout(() => flush(queue), delay);
  }

  function flush(queue, keepalive = false) {
    if (queue.inflight || !queue.pending || queue.submitting) return;
    const job = queue.pending;
    const id = job.p_id;
    queue.pending = null;
    let delay = 0;
    report(id, "正在同步作答…");
    queue.inflight = rpc("map_g6_save", job, keepalive).then(() => {
      report(id, "进度已同步到老师端");
    }).catch(error => {
      report(id, "进度已留在本机。" + mapMessage(error));
      if (!queue.submitting && !/^MAP_|^PGRST20/.test(error.message) && !["PGRST202", "PGRST205"].includes(error.code)) {
        queue.pending ??= job;
        delay = 4000;
      }
    }).finally(() => {
      queue.inflight = null;
      if (queue.pending && !queue.submitting) schedule(queue, delay);
    });
  }

  function queueFor(id) {
    if (!queues.has(id)) queues.set(id, { pending: null, inflight: null, submitting: false, timer: null });
    return queues.get(id);
  }

  window.addEventListener("pagehide", () => {
    for (const queue of queues.values()) flush(queue, true);
  });

  return {
    classCode,
    async catalog() {
      return rpc("map_g6_catalog");
    },
    async paper(id) {
      if (!loaded.has(id)) {
        loaded.set(id, rpc("map_g6_get_paper", { p_paper_id: id }).catch(error => {
          loaded.delete(id);
          throw error;
        }));
      }
      const result = await loaded.get(id);
      if (!result?.paper) throw new Error("这份原卷还没有导入。");
      return result;
    },
    show(record) {
      visibleId = record?.id || null;
      status.textContent = statuses.get(visibleId) || (
        record?.submittedAt ? "已交卷，老师可以查看"
          : record?.submitRequested ? "等待确认交卷，请点击重试"
          : record ? "作答保存在当前浏览器，正在同步" : ""
      );
    },
    save(record) {
      const queue = queueFor(record.id);
      queue.pending = payload(record, false);
      schedule(queue, 300);
    },
    async submit(record) {
      const queue = queueFor(record.id);
      queue.submitting = true;
      clearTimeout(queue.timer);
      queue.pending = null;
      report(record.id, "正在交卷，请稍等…");
      try {
        await queue.inflight;
        const result = await rpc("map_g6_save", payload(record, true), true);
        if (!result?.submitted_at || result.marks?.length !== record.questionIds.length) {
          throw new Error("尚未收到完整的交卷回执。");
        }
        report(record.id, "已交卷，老师可以查看");
        return result;
      } catch (error) {
        report(record.id, "交卷待确认。" + mapMessage(error) + " 请在本机重试。");
        throw error;
      } finally {
        queue.submitting = false;
      }
    },
  };
}

async function mountMapStudent() {
  const get = id => document.getElementById(id);
  const savedKey = "map-g6-identity";
  const saved = mapReadLocal(savedKey) || {};
  const link = new URLSearchParams(location.hash.slice(1));
  const code = get("class-code");
  const name = get("student-name");
  const form = get("join-form");
  const hint = get("join-status");
  const start = get("join-button");
  code.value = link.get("class") || saved.code || "";
  name.value = saved.code === code.value ? saved.name || "" : "";

  async function join() {
    const student = name.value.trim().toUpperCase();
    const classCode = code.value.trim().toLowerCase();
    if (!/^[A-Z]{1,12}[0-9]{0,4}$/.test(student)) {
      hint.textContent = "请输入姓名拼音缩写，例如 HQ 或 HQ2。";
      return;
    }
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(classCode)) {
      hint.textContent = "请粘贴班级码，或打开老师发的学生入口。";
      return;
    }
    start.disabled = true;
    hint.textContent = "正在连接题库…";
    try {
      const cloud = mapStudentCloud(classCode, student);
      const papers = await cloud.catalog();
      if (!papers?.length) throw new Error("题库尚未导入，请联系老师。");
      mapWriteLocal(savedKey, { code: classCode, name: student });
      get("join-view").hidden = true;
      get("practice-app").hidden = false;
      get("student-controls").hidden = false;
      get("edition").textContent = student + " · 学生版";
      get("change-student").onclick = () => {
        mapWriteLocal(savedKey, { code: classCode, name: "" });
        location.reload();
      };
      startMapPractice({ papers, images: {} }, cloud, student, link.get("paper"));
    } catch (error) {
      get("join-view").hidden = false;
      get("practice-app").hidden = true;
      get("student-controls").hidden = true;
      hint.textContent = mapMessage(error);
    } finally {
      start.disabled = false;
    }
  }

  form.addEventListener("submit", event => {
    event.preventDefault();
    join();
  });
  if (name.value && code.value) await join();
}
