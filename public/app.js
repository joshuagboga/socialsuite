// ---------------------------------------------------------------- helpers

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, { method = "GET", body, raw, headers } = {}) {
  const res = await fetch(path, {
    method,
    headers: raw ? headers : body ? { "Content-Type": "application/json" } : {},
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/api/login") { showLogin(); throw new Error(data.error || "Please sign in"); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (err ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), err ? 6000 : 3000);
}

function openModal(html) {
  $("#modal-card").innerHTML = html;
  $("#modal").classList.remove("hidden");
}
function closeModal() { $("#modal").classList.add("hidden"); }
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

const P_LETTER = { x: "𝕏", linkedin: "in", facebook: "f", instagram: "IG", threads: "@", bluesky: "🦋", mastodon: "M" };
const badge = (platform) => `<span class="pbadge p-${platform}" title="${esc(platformLabel(platform))}">${P_LETTER[platform] || "?"}</span>`;

const fmtDateTime = (ms) => new Date(ms).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const fmtTime = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const toLocalInput = (ms) => {
  const d = new Date(ms);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

// Character counting the way each platform does it.
const segmenter = new Intl.Segmenter();
function charCount(platform, text) {
  if (platform === "bluesky") return [...segmenter.segment(text)].length;
  if (platform === "x") return [...text.replace(/https?:\/\/\S+/g, "x".repeat(23))].length;
  return [...text].length;
}

// ---------------------------------------------------------------- state

const state = { platforms: [], accounts: [], settings: null };
const platformInfo = (id) => state.platforms.find((p) => p.id === id) || { label: id, limit: Infinity };
const platformLabel = (id) => platformInfo(id).label;

async function loadBase() {
  [state.platforms, state.accounts, state.settings] = await Promise.all([
    api("/api/platforms"), api("/api/accounts"), api("/api/settings"),
  ]);
}

// ---------------------------------------------------------------- auth

let authMode = "login"; // or "signup"
let signupAllowed = true;

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === "signup";
  const form = $("#login-form");
  $("#name-field").classList.toggle("hidden", !signup);
  $("#password-help").classList.toggle("hidden", !signup);
  form.password.autocomplete = signup ? "new-password" : "current-password";
  $("#login-lead").textContent = signup ? "Create your account" : "Sign in to your account";
  $("#login-submit").textContent = signup ? "Create account" : "Sign in";
  $("#switch-text").textContent = signup ? "Already have an account?" : "New here?";
  $("#switch-mode").textContent = signup ? "Sign in" : "Create an account";
  $("#login-switch").classList.toggle("hidden", !signup && !signupAllowed);
  $("#login-error").textContent = "";
}

function showLogin(mode = authMode) {
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
  setAuthMode(mode);
  $("#login-form").email.focus();
}

$("#switch-mode").addEventListener("click", () => setAuthMode(authMode === "signup" ? "login" : "signup"));

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const signup = authMode === "signup";
  const err = $("#login-error");
  const email = f.email.value.trim(), password = f.password.value;
  if (!email || !password) return (err.textContent = "Enter your email and password.");
  if (signup && password.length < 8) return (err.textContent = "Password must be at least 8 characters.");
  const btn = $("#login-submit");
  btn.disabled = true;
  try {
    await api(signup ? "/api/signup" : "/api/login", {
      method: "POST", body: signup ? { name: f.name.value, email, password } : { email, password },
    });
    f.password.value = "";
    $("#login").classList.add("hidden");
    await boot();
  } catch (error) {
    err.textContent = error.message;
  } finally {
    btn.disabled = false;
  }
});

$("#logout").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  location.hash = "";
  location.reload();
});

// ---------------------------------------------------------------- router

const routes = { calendar: renderCalendar, posts: renderPosts, compose: renderCompose, images: renderImages, accounts: renderAccounts, claude: renderClaude };

function parseHash() {
  const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const [route, arg] = path.split("/");
  return { route: routes[route] ? route : "calendar", arg, params: new URLSearchParams(query) };
}

async function router() {
  const { route, arg, params } = parseHash();
  $$("nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === route));
  const view = $("#view");
  try {
    await routes[route](view, arg, params);
  } catch (err) {
    view.innerHTML = `<div class="card error">${esc(err.message)}</div>`;
  }
}

window.addEventListener("hashchange", router);
document.addEventListener("click", (e) => {
  const nav = e.target.closest("[data-nav]");
  if (nav) location.hash = nav.dataset.nav;
});

async function boot() {
  const me = await api("/api/me");
  signupAllowed = me.signupAllowed;
  // A brand-new server has nobody to sign in as, so start on the sign-up form.
  if (!me.user) return showLogin(me.hasUsers ? "login" : "signup");
  $("#whoami").textContent = me.user.name;
  $("#whoami").title = me.user.email;
  await loadBase();
  $("#app").classList.remove("hidden");
  router();
}

// ---------------------------------------------------------------- compose

async function renderCompose(view, postId, params) {
  await loadBase();
  if (!state.accounts.length) {
    view.innerHTML = `<div class="page-head"><h1>New post</h1></div>
      <div class="card empty">Connect a social account first.<br><br><a class="btn primary" href="#/accounts">Connect accounts</a></div>`;
    return;
  }

  const editing = postId ? await api(`/api/posts/${postId}`) : null;
  const draft = {
    content: editing?.content ?? "",
    media_url: editing?.media_url ?? "",
    selected: new Set(editing ? editing.targets.map((t) => t.account_id) : state.accounts.map((a) => a.id).slice(0, 1)),
    variants: {},
    when: editing?.scheduled_at
      ? toLocalInput(editing.scheduled_at)
      : params.get("date")
        ? params.get("date") + "T09:00"
        : toLocalInput(Date.now() + 60 * 60_000),
  };
  for (const t of editing?.targets ?? []) if (t.content_override) draft.variants[t.platform] = t.content_override;

  const selectedPlatforms = () => [...new Set(state.accounts.filter((a) => draft.selected.has(a.id)).map((a) => a.platform))];

  view.innerHTML = `
    <div class="page-head">
      <div><h1>${editing ? "Edit post" : "New post"}</h1>
      ${editing ? `<span class="status s-${editing.status}">${editing.status}</span>` : ""}</div>
    </div>
    <div class="compose">
      <div class="stack">
        <div class="card stack">
          <div>
            <div class="row" style="margin-bottom:8px"><strong>Post to</strong><span class="spacer"></span>
              <button class="link small" id="sel-all">Select all</button></div>
            <div class="account-picker">
              ${state.accounts.map((a) => `
                <label class="acct-chip ${draft.selected.has(a.id) ? "on" : ""}" data-id="${a.id}">
                  <input type="checkbox" ${draft.selected.has(a.id) ? "checked" : ""}/>
                  ${badge(a.platform)}<span>${esc(a.handle || a.name)}</span>
                </label>`).join("")}
            </div>
          </div>
          <label>Post text
            <textarea id="content" placeholder="What do you want to share?">${esc(draft.content)}</textarea>
          </label>
          <div class="counters" id="counters"></div>

          <div class="stack" id="variants"></div>
          <div><button class="link small" id="add-variant">+ Customize text for a platform</button></div>

          <div>
            <strong>Image</strong> <span class="muted small">(optional; required for Instagram)</span>
            <div class="row" style="margin-top:8px" id="media-row"></div>
          </div>
        </div>
      </div>

      <div class="stack">
        <div class="card stack">
          <h2>When</h2>
          <label>Date & time <input type="datetime-local" id="when" value="${draft.when}" /></label>
          <span class="muted small">${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}</span>
          <button class="btn primary" id="schedule">${editing?.status === "scheduled" ? "Update schedule" : "Schedule"}</button>
          <div class="row">
            <button class="btn" id="now" style="flex:1">Post now</button>
            <button class="btn" id="save-draft" style="flex:1">Save draft</button>
          </div>
          ${editing ? `<button class="btn danger" id="delete">Delete post</button>` : ""}
          <p class="error small" id="form-error"></p>
        </div>

        <div class="card stack claude-box">
          <h2><span class="claude-mark"></span>Write with Claude</h2>
          ${state.settings.aiEnabled ? `
            <label>What's the post about?
              <textarea id="ai-brief" style="min-height:80px" placeholder="e.g. We launched dark mode today. Thank beta testers. Link: example.com/blog"></textarea>
            </label>
            <label>Tone <select id="ai-tone">
              <option value="">Natural</option><option>Professional</option><option>Casual and friendly</option>
              <option>Witty</option><option>Excited</option><option>Concise and direct</option>
            </select></label>
            <div class="row">
              <button class="btn primary" id="ai-write" style="flex:1">Draft for my platforms</button>
              <button class="btn" id="ai-improve" title="Rewrite the text you already have">Improve mine</button>
            </div>
            <span class="muted small">Writes a version for each selected platform within its character limit.</span>
          ` : `<p class="muted small">Add <code>ANTHROPIC_API_KEY</code> to your <code>.env</code> and restart to let Claude draft posts for you.</p>`}
        </div>
      </div>
    </div>`;

  const content = $("#content");

  function renderCounters() {
    const plats = selectedPlatforms();
    $("#counters").innerHTML = plats.length
      ? plats.map((p) => {
          const text = draft.variants[p] ?? content.value;
          const n = charCount(p, text), lim = platformInfo(p).limit;
          const src = draft.variants[p] != null ? " (custom)" : "";
          return `<span class="${n > lim ? "over" : ""}">${esc(platformLabel(p))}${src}: ${n}/${lim}</span>`;
        }).join("")
      : `<span class="error">No accounts selected</span>`;
  }

  function renderVariants() {
    const box = $("#variants");
    box.innerHTML = Object.entries(draft.variants)
      .map(([p, text]) => `
        <div class="variant" data-p="${p}">
          <div class="variant-head">${badge(p)} ${esc(platformLabel(p))} version
            <span class="spacer"></span><button class="link small" data-remove>Remove</button></div>
          <textarea>${esc(text)}</textarea>
        </div>`).join("");
    $$(".variant", box).forEach((el) => {
      const p = el.dataset.p;
      $("textarea", el).addEventListener("input", (e) => { draft.variants[p] = e.target.value; renderCounters(); });
      $("[data-remove]", el).addEventListener("click", () => { delete draft.variants[p]; renderVariants(); renderCounters(); });
    });
  }

  function renderMedia() {
    const row = $("#media-row");
    if (draft.media_url) {
      row.innerHTML = `<div class="media-preview"><img src="${esc(draft.media_url)}" alt="" />
        <button class="btn sm" id="media-clear">Remove</button></div>`;
      $("#media-clear").onclick = () => { draft.media_url = ""; renderMedia(); };
    } else {
      row.innerHTML = `
        <label class="btn sm" style="flex-direction:row">Upload image<input type="file" id="media-file" accept="${IMAGE_ACCEPT}" hidden /></label>
        <button class="btn sm" id="media-library" type="button">Choose from library</button>
        <span class="muted small">or</span>
        <input id="media-url" placeholder="Paste a public image URL" style="flex:1;min-width:180px" />`;
      $("#media-file").onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          const image = await uploadImage(file, file.name);
          draft.media_url = image.url; renderMedia();
        } catch (err) { toast(err.message, true); }
      };
      $("#media-library").onclick = () => chooseFromLibrary((image) => { draft.media_url = image.url; renderMedia(); });
      $("#media-url").onchange = (e) => { draft.media_url = e.target.value.trim(); renderMedia(); };
    }
  }

  $$(".acct-chip").forEach((chip) => chip.addEventListener("click", (e) => {
    e.preventDefault();
    const id = chip.dataset.id;
    draft.selected.has(id) ? draft.selected.delete(id) : draft.selected.add(id);
    chip.classList.toggle("on", draft.selected.has(id));
    renderCounters();
  }));
  $("#sel-all").onclick = () => {
    state.accounts.forEach((a) => draft.selected.add(a.id));
    $$(".acct-chip").forEach((c) => c.classList.add("on"));
    renderCounters();
  };
  content.addEventListener("input", renderCounters);

  $("#add-variant").onclick = () => {
    const options = selectedPlatforms().filter((p) => draft.variants[p] == null);
    if (!options.length) return toast("Every selected platform already has its own version");
    openModal(`<h2>Customize text for…</h2><div class="stack">
      ${options.map((p) => `<button class="btn" data-p="${p}">${badge(p)} ${esc(platformLabel(p))}</button>`).join("")}</div>`);
    $$("#modal-card [data-p]").forEach((b) => b.onclick = () => {
      draft.variants[b.dataset.p] = content.value;
      closeModal(); renderVariants(); renderCounters();
    });
  };

  async function aiDraft(mode) {
    const plats = selectedPlatforms();
    if (!plats.length) return toast("Select at least one account first", true);
    const brief = $("#ai-brief").value.trim();
    if (mode === "write" && !brief) return toast("Describe what the post is about", true);
    if (mode === "improve" && !content.value.trim()) return toast("Write a draft first", true);
    const btn = mode === "write" ? $("#ai-write") : $("#ai-improve");
    const label = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Writing…`;
    try {
      const { variants } = await api("/api/ai/draft", {
        method: "POST",
        body: { brief: brief || undefined, draft: mode === "improve" ? content.value : undefined, tone: $("#ai-tone").value, platforms: plats },
      });
      if (!variants.length) throw new Error("Claude returned no drafts");
      // Longest-limit platform's version becomes the main text; others become custom versions if they differ.
      const sorted = [...variants].sort((a, b) => platformInfo(b.platform).limit - platformInfo(a.platform).limit);
      content.value = sorted[0].text;
      draft.variants = {};
      for (const v of sorted.slice(1)) if (v.text !== content.value) draft.variants[v.platform] = v.text;
      renderVariants(); renderCounters();
      toast("Claude drafted your post. Review it before you schedule.");
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false; btn.innerHTML = label;
    }
  }
  if (state.settings.aiEnabled) {
    $("#ai-write").onclick = () => aiDraft("write");
    $("#ai-improve").onclick = () => aiDraft("improve");
  }

  function collect(kind) {
    const err = $("#form-error");
    err.textContent = "";
    const plats = selectedPlatforms();
    const problems = [];
    if (!draft.selected.size) problems.push("Select at least one account.");
    if (!content.value.trim()) problems.push("Post text is empty.");
    if (kind !== "draft") {
      for (const p of plats) {
        const n = charCount(p, draft.variants[p] ?? content.value), lim = platformInfo(p).limit;
        if (n > lim) problems.push(`${platformLabel(p)} text is ${n - lim} characters too long.`);
        if (platformInfo(p).requiresMedia && !draft.media_url) problems.push(`${platformLabel(p)} needs an image.`);
      }
    }
    const whenMs = new Date($("#when").value).getTime();
    if (kind === "schedule" && (!$("#when").value || Number.isNaN(whenMs))) problems.push("Pick a date and time.");
    if (kind === "schedule" && whenMs < Date.now() - 60_000) problems.push("That time is in the past. Use Post now instead.");
    if (problems.length) { err.innerHTML = problems.map(esc).join("<br>"); return null; }
    return {
      content: content.value,
      media_url: draft.media_url || null,
      draft: kind === "draft",
      scheduled_at: kind === "draft" ? ($("#when").value ? new Date(whenMs).toISOString() : null)
        : new Date(kind === "now" ? Date.now() : whenMs).toISOString(),
      targets: [...draft.selected].map((id) => {
        const a = state.accounts.find((x) => x.id === id);
        return { account_id: id, content_override: draft.variants[a.platform] ?? null };
      }),
    };
  }

  async function submit(kind, btn) {
    const body = collect(kind);
    if (!body) return;
    btn.disabled = true;
    try {
      const saved = editing
        ? await api(`/api/posts/${editing.id}`, { method: "PUT", body })
        : await api("/api/posts", { method: "POST", body });
      if (kind === "now") {
        const result = await api(`/api/posts/${saved.id}/publish`, { method: "POST" });
        const failed = result.targets.filter((t) => t.status !== "published");
        failed.length
          ? toast(`Published to ${result.targets.length - failed.length}/${result.targets.length}. ${failed[0].platform}: ${failed[0].error || "retrying"}`, true)
          : toast("Published!");
        location.hash = "#/posts/published";
      } else {
        toast(kind === "draft" ? "Draft saved" : `Scheduled for ${fmtDateTime(saved.scheduled_at)}`);
        location.hash = kind === "draft" ? "#/posts/draft" : "#/calendar";
      }
    } catch (err) {
      $("#form-error").textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  }
  $("#schedule").onclick = (e) => submit("schedule", e.currentTarget);
  $("#now").onclick = (e) => submit("now", e.currentTarget);
  $("#save-draft").onclick = (e) => submit("draft", e.currentTarget);
  if (editing) $("#delete").onclick = async () => {
    if (!confirm("Delete this post? It will not be published.")) return;
    await api(`/api/posts/${editing.id}`, { method: "DELETE" });
    toast("Deleted");
    location.hash = "#/posts";
  };

  if (editing && !["draft", "scheduled", "failed"].includes(editing.status)) {
    $$("#view button, #view textarea, #view input").forEach((el) => (el.disabled = true));
    $("#form-error").textContent = `This post is ${editing.status} and can no longer be edited.`;
  }

  renderVariants(); renderMedia(); renderCounters();
}

// ---------------------------------------------------------------- posts list

function targetChips(post) {
  return `<div class="targets">${post.targets.map((t) => {
    const cls = t.status === "failed" ? "t-failed" : t.status === "published" ? "t-published" : "";
    const label = esc(t.account_handle || t.account_name);
    const inner = `${badge(t.platform)}<span class="${cls}">${label}</span>`;
    const title = t.error ? ` title="${esc(t.error)}"` : "";
    return t.remote_url
      ? `<a class="target" href="${esc(t.remote_url)}" target="_blank" rel="noopener"${title}>${inner} ↗</a>`
      : `<span class="target"${title}>${inner}</span>`;
  }).join("")}</div>`;
}

async function renderPosts(view, tab = "scheduled") {
  const tabs = { scheduled: "Scheduled", draft: "Drafts", published: "Published", failed: "Failed" };
  if (!tabs[tab]) tab = "scheduled";
  view.innerHTML = `
    <div class="page-head"><h1>Posts</h1><a class="btn primary" href="#/compose">+ New post</a></div>
    <div class="tabs">${Object.entries(tabs).map(([k, v]) =>
      `<button data-nav="#/posts/${k}" class="${k === tab ? "active" : ""}">${v}</button>`).join("")}</div>
    <div class="card" id="list"><div class="empty"><span class="spinner"></span></div></div>`;

  let posts = await api(`/api/posts?status=${tab}`);
  if (tab === "failed") posts = posts.concat(await api("/api/posts?status=partial"));
  if (tab === "scheduled") posts = posts.concat(await api("/api/posts?status=publishing")).sort((a, b) => a.scheduled_at - b.scheduled_at);

  const list = $("#list");
  if (!posts.length) {
    list.innerHTML = `<div class="empty">No ${tabs[tab].toLowerCase()} posts.</div>`;
    return;
  }
  list.innerHTML = posts.map((p) => {
    const editable = ["draft", "scheduled", "failed"].includes(p.status);
    const when = p.scheduled_at ? fmtDateTime(p.scheduled_at) : "No time set";
    const errors = p.targets.filter((t) => t.error && t.status !== "published");
    const retrying = p.status === "scheduled" && p.next_attempt_at;
    return `
      <div class="post-item" data-id="${p.id}">
        <div>
          <div class="post-when">${when}</div>
          <span class="status s-${p.status}">${p.status}</span>
          ${p.source === "claude" ? `<div class="claude-tag">via Claude</div>` : ""}
        </div>
        <div>
          <div class="post-text">${esc(p.content)}</div>
          ${p.media_url ? `<div class="muted small">🖼 image attached</div>` : ""}
          ${targetChips(p)}
          ${errors.map((t) => `<div class="error small">${esc(platformLabel(t.platform))}: ${esc(t.error)}</div>`).join("")}
          ${retrying ? `<div class="muted small">Trying again at ${fmtTime(p.next_attempt_at)}</div>` : ""}
        </div>
        <div class="row" style="align-items:flex-start">
          ${editable ? `<a class="btn sm" href="#/compose/${p.id}">Edit</a>` : ""}
          ${["draft", "scheduled", "failed", "partial"].includes(p.status) ? `<button class="btn sm" data-act="now">${p.status === "failed" || p.status === "partial" ? "Retry" : "Post now"}</button>` : ""}
          ${p.status !== "publishing" ? `<button class="btn sm danger" data-act="del">Delete</button>` : ""}
        </div>
      </div>`;
  }).join("");

  $$("[data-act]", list).forEach((btn) => btn.addEventListener("click", async () => {
    const id = btn.closest(".post-item").dataset.id;
    btn.disabled = true;
    try {
      if (btn.dataset.act === "del") {
        if (!confirm("Delete this post?")) return;
        await api(`/api/posts/${id}`, { method: "DELETE" });
        toast("Deleted");
      } else {
        const r = await api(`/api/posts/${id}/publish`, { method: "POST" });
        toast(r.status === "published" ? "Published!" : `Status: ${r.status}`, r.status !== "published");
      }
      router();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  }));
}

// ---------------------------------------------------------------- calendar

let calMonth = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })();

async function renderCalendar(view) {
  const start = new Date(calMonth);
  start.setDate(1 - start.getDay());
  const end = new Date(start);
  end.setDate(start.getDate() + 42);

  const posts = (await api(`/api/posts?from=${start.getTime()}&to=${end.getTime()}`)).filter((p) => p.scheduled_at);
  const byDay = {};
  for (const p of posts) {
    const key = new Date(p.scheduled_at).toDateString();
    (byDay[key] ??= []).push(p);
  }
  Object.values(byDay).forEach((list) => list.sort((a, b) => a.scheduled_at - b.scheduled_at));

  const todayKey = new Date().toDateString();
  const upcoming = posts.filter((p) => p.status === "scheduled").length;
  const days = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = d.toDateString();
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    days.push(`
      <div class="cal-day ${d.getMonth() !== calMonth.getMonth() ? "other" : ""} ${key === todayKey ? "today" : ""}" data-date="${iso}">
        <span class="cal-num">${d.getDate()}</span>
        ${(byDay[key] || []).map((p) => `
          <div class="cal-post ${p.status}" data-id="${p.id}" title="${esc(p.content)}">
            ${fmtTime(p.scheduled_at)} · ${p.targets.map((t) => P_LETTER[t.platform]).join(" ")} · ${esc(p.content.slice(0, 60))}
          </div>`).join("")}
      </div>`);
  }

  view.innerHTML = `
    <div class="page-head">
      <div><h1>Calendar</h1><span class="muted">${upcoming} scheduled this view · ${state.accounts.length} connected account${state.accounts.length === 1 ? "" : "s"}</span></div>
      <div class="cal-head">
        <button class="btn sm" id="prev" aria-label="Previous month">‹</button>
        <h2 style="text-align:center">${calMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h2>
        <button class="btn sm" id="next" aria-label="Next month">›</button>
        <button class="btn sm" id="today">Today</button>
      </div>
    </div>
    ${state.accounts.length ? "" : `<div class="card row" style="margin-bottom:16px">Connect your social accounts to start scheduling.<span class="spacer"></span><a class="btn primary" href="#/accounts">Connect accounts</a></div>`}
    <div class="cal">
      ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => `<div class="cal-dow">${d}</div>`).join("")}
      ${days.join("")}
    </div>
    <p class="muted small">Click a day to schedule a post on it.</p>`;

  $("#prev").onclick = () => { calMonth.setMonth(calMonth.getMonth() - 1); renderCalendar(view); };
  $("#next").onclick = () => { calMonth.setMonth(calMonth.getMonth() + 1); renderCalendar(view); };
  $("#today").onclick = () => { const d = new Date(); calMonth = new Date(d.getFullYear(), d.getMonth(), 1); renderCalendar(view); };
  $$(".cal-day").forEach((el) => el.addEventListener("click", (e) => {
    const post = e.target.closest(".cal-post");
    if (post) return showPostModal(posts.find((p) => p.id === post.dataset.id));
    location.hash = `#/compose?date=${el.dataset.date}`;
  }));
}

function showPostModal(p) {
  const editable = ["draft", "scheduled", "failed"].includes(p.status);
  openModal(`
    <div class="row" style="margin-bottom:10px"><strong>${fmtDateTime(p.scheduled_at)}</strong>
      <span class="status s-${p.status}">${p.status}</span></div>
    <div style="white-space:pre-wrap;word-break:break-word">${esc(p.content)}</div>
    ${p.media_url ? `<img src="${esc(p.media_url)}" alt="" style="max-width:100%;border-radius:8px;margin-top:10px" />` : ""}
    ${targetChips(p)}
    ${p.targets.filter((t) => t.error).map((t) => `<div class="error small">${esc(platformLabel(t.platform))}: ${esc(t.error)}</div>`).join("")}
    <div class="row" style="margin-top:16px;justify-content:flex-end">
      <button class="btn" onclick="document.getElementById('modal').classList.add('hidden')">Close</button>
      ${editable ? `<a class="btn primary" href="#/compose/${p.id}" id="edit-link">Edit</a>` : ""}
    </div>`);
  $("#edit-link")?.addEventListener("click", closeModal);
}

// ---------------------------------------------------------------- image library

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const IMAGE_ACCEPT = IMAGE_TYPES.join(",");
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");

/** A small JPEG of the image, made in the browser. Used for the grid and for Claude's preview. */
async function makeThumb(blob) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, 512 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // transparent PNGs would otherwise turn black as JPEG
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
}

/** Add one image to the library. `source` is "drive" for Google Drive imports. Returns the saved image. */
async function uploadImage(blob, name, source) {
  if (!IMAGE_TYPES.includes(blob.type)) throw new Error(`${name || "That file"} is not a PNG, JPEG, GIF or WebP image`);
  if (blob.size > MAX_IMAGE_BYTES) throw new Error(`${name || "That image"} is larger than 8 MB`);
  const headers = { "Content-Type": blob.type, "X-File-Name": encodeURIComponent(name || "") };
  if (source) headers["X-Image-Source"] = source;
  let { image } = await api("/api/images", { method: "POST", raw: blob, headers });
  try {
    const thumb = await makeThumb(blob);
    if (thumb) image = await api(`/api/images/${image.id}/thumb`, { method: "PUT", raw: thumb, headers: { "Content-Type": "image/jpeg" } });
  } catch {} // the image is saved; it just has no small preview
  return image;
}

const imageTile = (img, actions) => `
  <div class="img-card" data-id="${img.id}">
    <div class="img-thumb"><img src="${esc(img.thumb_url || img.url)}" alt="" loading="lazy" /></div>
    <div class="img-name" title="${esc(img.name)}">${esc(img.name)}</div>
    <div class="muted small">${fmtSize(img.size)}${img.source === "drive" ? " · Google Drive" : ""}</div>
    ${actions}
  </div>`;

/** Modal grid of the library; calls onPick(image) with the one the user clicks. */
async function chooseFromLibrary(onPick) {
  const images = await api("/api/images");
  if (!images.length) {
    openModal(`<h2>Your image library is empty</h2>
      <p class="muted">Add pictures on the Images page, then you can pick them here.</p>
      <div class="row" style="justify-content:flex-end;margin-top:14px"><a class="btn primary" href="#/images" id="go-images">Open Images</a></div>`);
    $("#go-images").onclick = closeModal;
    return;
  }
  openModal(`<h2>Choose an image</h2>
    <div class="img-grid pick">${images.map((img) => imageTile(img, "")).join("")}</div>`);
  $$("#modal-card .img-card").forEach((el) => el.onclick = () => {
    closeModal();
    onPick(images.find((i) => i.id === el.dataset.id));
  });
}

async function renderImages(view) {
  state.settings = await api("/api/settings");
  const images = await api("/api/images");
  const drive = !!state.settings.google?.clientId;
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Images</h1><span class="muted">Pictures you can attach to posts. Claude can attach these for you by name.</span></div>
      <div class="row">
        <label class="btn primary" style="flex-direction:row">Upload images<input type="file" id="img-files" accept="${IMAGE_ACCEPT}" multiple hidden /></label>
        <button class="btn" id="img-drive">Add from Google Drive</button>
      </div>
    </div>
    <p class="muted small" id="img-status" role="status"></p>
    ${images.length ? `<div class="img-grid">${images.map((img) => imageTile(img, `
        <div class="row img-actions">
          <button class="btn sm" data-rename>Rename</button>
          <button class="btn sm" data-copy>Copy link</button>
          <button class="btn sm danger" data-del>Delete</button>
        </div>`)).join("")}</div>`
      : `<div class="card empty">No images yet. Upload some from this device${drive ? " or add them from Google Drive" : ""}.<br>
           Give them clear names, because that is how Claude finds them.</div>`}`;

  const status = (msg) => { $("#img-status").textContent = msg; };

  // Add several images one after another, reporting progress and any that were skipped.
  async function addAll(items, source) {
    const problems = [];
    let done = 0;
    for (const item of items) {
      status(`Adding ${done + 1} of ${items.length}…`);
      try { await uploadImage(await item.blob(), item.name, source); done++; }
      catch (err) { problems.push(err.message); }
    }
    if (problems.length) toast(`Added ${done}. Skipped ${problems.length}: ${problems[0]}`, true);
    else if (done) toast(`Added ${done} image${done === 1 ? "" : "s"}`);
    renderImages(view);
  }

  $("#img-files").onchange = (e) => {
    const files = [...e.target.files];
    if (files.length) addAll(files.map((f) => ({ name: f.name, blob: async () => f })));
  };

  $("#img-drive").onclick = async () => {
    if (!drive) return showDriveHelp();
    try {
      status("Opening Google Drive…");
      const picked = await pickFromDrive(state.settings.google);
      status("");
      if (picked.length) await addAll(picked, "drive");
    } catch (err) {
      status("");
      toast(err.message, true);
    }
  };

  $$(".img-card", view).forEach((el) => {
    const img = images.find((i) => i.id === el.dataset.id);
    $("[data-rename]", el).onclick = async () => {
      const name = prompt("Name for this image", img.name);
      if (name == null || !name.trim() || name.trim() === img.name) return;
      try { await api(`/api/images/${img.id}`, { method: "PATCH", body: { name } }); renderImages(view); }
      catch (err) { toast(err.message, true); }
    };
    $("[data-copy]", el).onclick = async () => { await navigator.clipboard.writeText(img.url); toast("Link copied"); };
    $("[data-del]", el).onclick = async () => {
      if (!confirm(`Delete "${img.name}" from your library?`)) return;
      try { await api(`/api/images/${img.id}`, { method: "DELETE" }); toast("Deleted"); renderImages(view); }
      catch (err) { toast(err.message, true); }
    };
  });
}

// ---------------------------------------------------------------- Google Drive picker
// The browser signs in to Google and opens Google's own file picker. Only the images the user
// ticks are shared with this app (the "drive.file" permission), and the browser copies them into
// the SocialSuite library. The server never sees a Google token.

const loadedScripts = {};
function loadScript(src) {
  return (loadedScripts[src] ??= new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src; el.async = true;
    el.onload = resolve;
    el.onerror = () => { delete loadedScripts[src]; reject(new Error("Could not load Google's sign-in. Check your connection or ad blocker.")); };
    document.head.append(el);
  }));
}

function googleToken(clientId) {
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: "https://www.googleapis.com/auth/drive.file",
      callback: (r) => (r.error ? reject(new Error(r.error_description || "Google sign-in was not completed")) : resolve(r.access_token)),
      error_callback: (e) => reject(new Error(e.type === "popup_closed" ? "Google sign-in was closed" : e.message || "Google sign-in failed")),
    });
    client.requestAccessToken();
  });
}

/** Opens the picker. Resolves to [{ name, blob() }] for the images the user chose ([] if cancelled). */
async function pickFromDrive({ clientId, apiKey }) {
  await Promise.all([loadScript("https://accounts.google.com/gsi/client"), loadScript("https://apis.google.com/js/api.js")]);
  await new Promise((resolve) => gapi.load("picker", resolve));
  const token = await googleToken(clientId);

  const docs = await new Promise((resolve) => {
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS_IMAGES)
      .setIncludeFolders(true).setMimeTypes(IMAGE_ACCEPT);
    const builder = new google.picker.PickerBuilder()
      .addView(view)
      .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(token)
      .setAppId(clientId.split("-")[0]) // the project number; lets "drive.file" cover the picked files
      .setTitle("Choose images to add to SocialSuite")
      .setCallback((data) => {
        if (data.action === google.picker.Action.PICKED) resolve(data.docs || []);
        else if (data.action === google.picker.Action.CANCEL) resolve([]);
      });
    if (apiKey) builder.setDeveloperKey(apiKey);
    builder.build().setVisible(true);
  });

  return docs.map((doc) => ({
    name: doc.name,
    async blob() {
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(doc.id)}?alt=media`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`Could not download ${doc.name} from Google Drive (${res.status})`);
      const data = await res.blob();
      // Drive reports the real type on the file; the download response is not always labelled.
      const type = IMAGE_TYPES.includes(data.type) ? data.type : doc.mimeType;
      return new Blob([data], { type });
    },
  }));
}

function showDriveHelp() {
  const origin = new URL(state.settings.publicUrl).origin;
  openModal(`
    <h2>Set up Google Drive</h2>
    <div class="stack">
      <p>Google requires the owner of this site to register it once. After that, anyone using it can add images from their own Drive.</p>
      <ol class="steps">
        <li>In the <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">Google Cloud console</a>, create a project and enable the <strong>Google Drive API</strong> and the <strong>Google Picker API</strong>.</li>
        <li>Set up the OAuth consent screen and create an <strong>OAuth client ID</strong> of type Web application. Add this under Authorized JavaScript origins:
          <div class="copy-field" style="margin-top:6px"><input readonly value="${esc(origin)}" /></div></li>
        <li>Create an <strong>API key</strong> and restrict it to this website and the Google Picker API.</li>
        <li>Set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_API_KEY</code> in the server's environment and restart it.</li>
      </ol>
      <div class="row" style="justify-content:flex-end"><button class="btn" id="close-help">Close</button></div>
    </div>`);
  $("#close-help").onclick = closeModal;
}

// ---------------------------------------------------------------- accounts

async function renderAccounts(view, _arg, params) {
  await loadBase();
  if (params.get("connected")) toast(`Connected ${params.get("connected")} account(s)`);
  if (params.get("error")) toast(params.get("error"), true);
  if (params.has("connected") || params.has("error")) history.replaceState(null, "", "#/accounts");

  const connectable = state.platforms.filter((p) => !p.connectVia);
  view.innerHTML = `
    <div class="page-head"><div><h1>Accounts</h1><span class="muted">Connect the profiles and pages you want to post to.</span></div></div>
    <div class="card" style="margin-bottom:20px">
      <h2>Connected (${state.accounts.length})</h2>
      ${state.accounts.length ? state.accounts.map((a) => {
        const expiring = a.token_expires_at && a.token_expires_at < Date.now() + 7 * 864e5 && !["x", "threads"].includes(a.platform);
        return `
        <div class="acct-row">
          ${a.avatar_url ? `<img class="avatar" src="${esc(a.avatar_url)}" alt="" referrerpolicy="no-referrer" />` : `<span class="avatar"></span>`}
          <div class="who">
            <div><strong>${esc(a.name)}</strong> ${a.handle ? `<span class="muted">${esc(a.handle)}</span>` : ""}</div>
            <div class="small muted">${badge(a.platform)} ${esc(platformLabel(a.platform))}
              ${expiring ? ` · <span class="error">token expires ${new Date(a.token_expires_at).toLocaleDateString()} — reconnect</span>` : ""}</div>
          </div>
          ${platformInfo(a.platform).kind === "oauth" ? `<a class="btn sm" href="/auth/${a.platform}/start">Reconnect</a>` : ""}
          <button class="btn sm danger" data-del="${a.id}">Disconnect</button>
        </div>`;
      }).join("") : `<p class="muted">Nothing connected yet.</p>`}
    </div>
    <h2>Add an account</h2>
    <div class="grid-cards">
      ${connectable.map((p) => `
        <div class="card connect-card">
          ${badge(p.id)}
          <div style="flex:1">
            <strong>${esc(p.id === "facebook" ? "Facebook + Instagram" : p.label)}</strong>
            <div class="small muted">${p.id === "facebook" ? "Pages and linked Instagram business accounts" : p.kind === "oauth" ? "Sign in with " + esc(p.label) : "App password / token"}</div>
            ${p.kind === "oauth" && !p.configured ? `<div class="small error">Needs app keys in .env</div>` : ""}
          </div>
          <button class="btn sm" data-connect="${p.id}">Connect</button>
        </div>`).join("")}
    </div>`;

  $$("[data-del]").forEach((b) => b.onclick = async () => {
    if (!confirm("Disconnect this account? Scheduled posts will no longer go to it.")) return;
    await api(`/api/accounts/${b.dataset.del}`, { method: "DELETE" });
    toast("Disconnected");
    renderAccounts(view, null, new URLSearchParams());
  });

  $$("[data-connect]").forEach((b) => b.onclick = () => {
    const p = platformInfo(b.dataset.connect);
    if (p.kind === "oauth") {
      if (!p.configured) return showSetupHelp(p);
      location.href = `/auth/${p.id}/start`;
      return;
    }
    openModal(`
      <h2>${badge(p.id)} Connect ${esc(p.label)}</h2>
      <form class="stack" id="cred-form">
        ${p.fields.map((f) => `
          <label>${esc(f.label)}
            <input name="${f.name}" type="${f.type || "text"}" placeholder="${esc(f.placeholder || "")}" autocomplete="off" />
            ${f.help ? `<span class="help small muted">${esc(f.help)}</span>` : ""}
          </label>`).join("")}
        <p class="error small" id="cred-error"></p>
        <div class="row" style="justify-content:flex-end">
          <button type="button" class="btn" id="cred-cancel">Cancel</button>
          <button class="btn primary">Connect</button>
        </div>
      </form>`);
    $("#cred-cancel").onclick = closeModal;
    $("#cred-form").onsubmit = async (e) => {
      e.preventDefault();
      const btn = $("button.primary", e.target);
      btn.disabled = true;
      try {
        await api(`/api/accounts/connect/${p.id}`, { method: "POST", body: Object.fromEntries(new FormData(e.target)) });
        closeModal();
        toast(`${p.label} connected`);
        renderAccounts(view, null, new URLSearchParams());
      } catch (err) {
        $("#cred-error").textContent = err.message;
        btn.disabled = false;
      }
    };
  });
}

const SETUP = {
  x: { portal: "https://developer.x.com/en/portal/dashboard", env: "X_CLIENT_ID, X_CLIENT_SECRET",
       notes: "Create a project + app, enable OAuth 2.0 (type: Web App), and add the callback URL below." },
  linkedin: { portal: "https://www.linkedin.com/developers/apps", env: "LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET",
       notes: "Add the products “Sign In with LinkedIn using OpenID Connect” and “Share on LinkedIn”, then add the redirect URL below." },
  facebook: { portal: "https://developers.facebook.com/apps", env: "META_APP_ID, META_APP_SECRET",
       notes: "Create a Business app with Facebook Login for Business, add the Pages and Instagram permissions, and add the redirect URL below." },
  threads: { portal: "https://developers.facebook.com/apps", env: "THREADS_APP_ID, THREADS_APP_SECRET",
       notes: "Create an app with the Threads API use case and add the redirect URL below." },
};

function showSetupHelp(p) {
  const s = SETUP[p.id];
  openModal(`
    <h2>${badge(p.id)} Set up ${esc(p.label)}</h2>
    <div class="stack">
      <p>${esc(p.label)} requires your own developer app. This is a one-time setup.</p>
      <ol class="steps">
        <li>Open the <a href="${s.portal}" target="_blank" rel="noopener">developer portal</a>. ${esc(s.notes)}</li>
        <li>Callback / redirect URL:<div class="copy-field" style="margin-top:6px"><input readonly value="${esc(state.settings.redirectUris[p.id])}" /></div></li>
        <li>Put <code>${esc(s.env)}</code> in your <code>.env</code> file and restart the server.</li>
      </ol>
      <div class="row" style="justify-content:flex-end"><button class="btn" id="close-help">Close</button></div>
    </div>`);
  $("#close-help").onclick = closeModal;
}

// ---------------------------------------------------------------- Claude connector

async function renderClaude(view) {
  const s = (state.settings = await api("/api/settings"));
  const isLocal = /localhost|127\.0\.0\.1/.test(s.publicUrl);
  const cliCmd = `claude mcp add --transport http socialsuite ${s.mcp.url} --header "Authorization: Bearer ${s.mcp.key}"`;
  const desktopJson = JSON.stringify({ mcpServers: { socialsuite: { command: "npx", args: ["-y", "mcp-remote", s.mcp.url, "--header", `Authorization: Bearer ${s.mcp.key}`] } } }, null, 2);

  view.innerHTML = `
    <div class="page-head"><div><h1>Claude connector</h1>
      <span class="muted">Let Claude see your accounts and schedule, edit, or publish posts for you.</span></div></div>
    <div class="stack">
      <div class="card stack">
        <h2>Your connector URL</h2>
        <p class="muted small" style="margin:0">Treat this like a password. It contains your secret key, and it only gives access to your own accounts and posts.</p>
        <div class="copy-field"><input readonly value="${esc(s.mcp.urlWithKey)}" id="mcp-url" type="password" />
          <button class="btn sm" data-toggle="mcp-url">Show</button>
          <button class="btn sm" data-copy="${esc(s.mcp.urlWithKey)}">Copy</button></div>
        ${isLocal ? `<p class="small" style="margin:0">⚠ <strong>claude.ai</strong> can't reach <code>localhost</code>. Deploy SocialSuite or expose it with a tunnel (for example <code>cloudflared tunnel --url http://localhost:3000</code>), then set <code>PUBLIC_URL</code> in <code>.env</code> to the HTTPS address. Claude Code and Claude Desktop on this computer work with localhost.</p>` : ""}
        <div class="row"><button class="btn sm danger" id="rotate">Generate a new key</button><span class="muted small">This breaks existing connections.</span></div>
      </div>

      <div class="card stack">
        <h2>claude.ai or the Claude app</h2>
        <ol class="steps">
          <li>Open <strong>Settings → Connectors</strong> and choose <strong>Add custom connector</strong>.</li>
          <li>Name it <em>SocialSuite</em> and paste the connector URL above.</li>
          <li>Enable it in a chat from the tools menu, then ask something like:<br>
            <em>“Write a LinkedIn and X post about our new pricing page and schedule it for Tuesday 9am.”</em></li>
        </ol>
      </div>

      <div class="card stack">
        <h2>Claude Code</h2>
        <pre class="mono">${esc(cliCmd)}</pre>
        <div><button class="btn sm" data-copy="${esc(cliCmd)}">Copy command</button></div>
      </div>

      <div class="card stack">
        <h2>Claude Desktop (config file)</h2>
        <p class="muted small" style="margin:0">Add to <code>claude_desktop_config.json</code> if you prefer a local config over the Connectors screen.</p>
        <pre class="mono">${esc(desktopJson)}</pre>
        <div><button class="btn sm" data-copy="${esc(desktopJson)}">Copy JSON</button></div>
      </div>

      <div class="card stack">
        <h2>What Claude can do</h2>
        <div class="grid-cards">
          ${[
            ["list_accounts", "See connected accounts and character limits"],
            ["list_images / view_image", "Find a picture in your image library and attach it"],
            ["schedule_post", "Schedule or draft a post, with per-platform versions"],
            ["publish_now", "Post immediately, or push a scheduled post out now"],
            ["list_posts / get_post", "Review your queue, results and errors"],
            ["update_post", "Change text, time, accounts or image"],
            ["delete_post", "Cancel a scheduled post"],
          ].map(([n, d]) => `<div><code>${n}</code><div class="small muted">${d}</div></div>`).join("")}
        </div>
      </div>
    </div>`;

  $$("[data-copy]").forEach((b) => b.onclick = async () => {
    await navigator.clipboard.writeText(b.dataset.copy);
    toast("Copied");
  });
  $$("[data-toggle]").forEach((b) => b.onclick = () => {
    const input = $("#" + b.dataset.toggle);
    input.type = input.type === "password" ? "text" : "password";
    b.textContent = input.type === "password" ? "Show" : "Hide";
  });
  $("#rotate")?.addEventListener("click", async () => {
    if (!confirm("Generate a new key? Claude will lose access until you update the connector URL.")) return;
    await api("/api/settings/rotate-mcp-key", { method: "POST" });
    toast("New key generated");
    renderClaude(view);
  });
}

// ---------------------------------------------------------------- go

boot().catch((err) => {
  document.body.innerHTML = `<div class="login"><div class="card error">${esc(err.message)}</div></div>`;
});
