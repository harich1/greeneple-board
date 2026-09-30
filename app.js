import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, LOGIN_DOMAIN } from "./config.js";

if (window.top !== window.self) {
  document.body.textContent = "보안을 위해 게시판 주소를 직접 열어 주세요.";
  throw new Error("Framed execution blocked");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const state = {
  session: null,
  profile: null,
  posts: [],
  activePost: null,
  comments: [],
  editingPostId: null,
  editorInitial: null,
  editorReturnView: "list-view",
  page: 1,
  pageSize: 20,
  totalPosts: 0,
  searchQuery: "",
};
let appInitialized = false;
const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const $ = (id) => document.getElementById(id);
const views = ["list-view", "editor-view", "detail-view"];

function showToast(message, isError = false) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2600);
}

function errorMessage(error, fallback) {
  const status = Number(error?.status || error?.statusCode);
  const code = String(error?.code || "");
  const message = String(error?.message || "").toLowerCase();
  if (!state.session || status === 401 || message.includes("jwt")) return "로그인이 만료되었습니다. 다시 로그인해 주세요.";
  if (status === 403 || code === "42501" || message.includes("permission")) return "이 작업을 수행할 권한이 없습니다.";
  if (status === 429 || message.includes("rate limit")) return "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.";
  if (message.includes("failed to fetch") || message.includes("network")) return "네트워크 연결을 확인한 뒤 다시 시도해 주세요.";
  if (code === "23514" || code === "22001") return "입력 가능한 글자 수를 확인해 주세요.";
  return fallback;
}

function setButtonLoading(button, loading, loadingText = "처리 중…") {
  if (!button) return;
  if (loading) {
    button.dataset.originalText = button.textContent;
    button.textContent = loadingText;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

function showView(id) {
  views.forEach((view) => $(view).classList.toggle("hidden", view !== id));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function escapeHtml(value = "") {
  return value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function linkify(value = "") {
  return escapeHtml(value).replace(/(https?:\/\/[^\s<]+)/gi, (url) => {
    const clean = url.replace(/[),.!?]+$/, "");
    const tail = url.slice(clean.length);
    return `<a href="${clean}" target="_blank" rel="noopener noreferrer">${clean}</a>${tail}`;
  });
}

function formatDate(value, withTime = false) {
  const date = new Date(value);
  return new Intl.DateTimeFormat("ko-KR", withTime
    ? { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }
    : { year: "2-digit", month: "2-digit", day: "2-digit" }).format(date);
}

function wasUpdated(createdAt, updatedAt) {
  return updatedAt && new Date(updatedAt).getTime() - new Date(createdAt).getTime() > 1000;
}

function canManage(authorId) {
  return state.profile?.is_admin || authorId === state.session?.user?.id;
}

function draftStorageKey() {
  return state.session?.user?.id ? `greeneple-board:draft:${state.session.user.id}` : null;
}

function savePostDraft() {
  if (state.editingPostId !== null) return;
  const key = draftStorageKey();
  if (!key) return;
  const title = $("post-title").value;
  const content = $("post-content").value;
  try {
    if (!title && !content) {
      localStorage.removeItem(key);
      $("draft-status").textContent = "작성 내용은 자동으로 임시저장됩니다.";
      return;
    }
    localStorage.setItem(key, JSON.stringify({ title, content, savedAt: new Date().toISOString() }));
    $("draft-status").textContent = "임시저장됨";
  } catch (error) {
    console.error(error);
    $("draft-status").textContent = "임시저장에 실패했습니다.";
  }
}

function loadPostDraft() {
  const key = draftStorageKey();
  if (!key) return null;
  try {
    const value = localStorage.getItem(key);
    if (!value) return null;
    const draft = JSON.parse(value);
    const savedAt = Date.parse(draft?.savedAt);
    const valid = typeof draft?.title === "string"
      && typeof draft?.content === "string"
      && draft.title.length <= 150
      && draft.content.length <= 10000
      && Number.isFinite(savedAt)
      && Date.now() - savedAt <= DRAFT_MAX_AGE_MS;
    if (!valid) {
      localStorage.removeItem(key);
      return null;
    }
    return draft;
  } catch (error) {
    console.error(error);
    localStorage.removeItem(key);
    return null;
  }
}

function clearPostDraft() {
  const key = draftStorageKey();
  if (key) localStorage.removeItem(key);
  $("draft-status").textContent = "";
}

function scheduleDraftSave() {
  if (state.editingPostId !== null) return;
  window.clearTimeout(scheduleDraftSave.timer);
  $("draft-status").textContent = "임시저장 중…";
  scheduleDraftSave.timer = window.setTimeout(savePostDraft, 300);
}

async function loadProfile() {
  const { data, error } = await supabase.from("profiles").select("id, username, display_name, is_admin").eq("id", state.session.user.id).single();
  if (error) throw error;
  state.profile = data;
  $("current-user").textContent = `${data.display_name}${data.is_admin ? " · 관리자" : ""}`;
}

function sanitizedSearchQuery(value) {
  return value.replace(/[%_*,()"'\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

async function loadPosts(page = state.page) {
  const loading = $("list-loading");
  loading.classList.remove("hidden");
  $("post-list").setAttribute("aria-busy", "true");
  try {
    state.page = Math.max(1, page);
    const from = (state.page - 1) * state.pageSize;
    const to = from + state.pageSize - 1;
    let query = supabase
      .from("posts")
      .select("id, title, author_id, author_name, view_count, created_at, updated_at, comments(count)", { count: "exact" });
    if (state.searchQuery) {
      const term = sanitizedSearchQuery(state.searchQuery);
      query = query.or(`title.ilike.*${term}*,content.ilike.*${term}*,author_name.ilike.*${term}*`);
    }
    const { data, error, count } = await query.order("id", { ascending: false }).range(from, to);
    if (error) throw error;
    state.posts = data || [];
    state.totalPosts = count || 0;
    const totalPages = Math.max(1, Math.ceil(state.totalPosts / state.pageSize));
    if (state.page > totalPages) return loadPosts(totalPages);
    renderPosts();
    renderPagination();
    return true;
  } catch (error) {
    showToast(errorMessage(error, "게시물 목록을 불러오지 못했습니다."), true);
    return false;
  } finally {
    loading.classList.add("hidden");
    $("post-list").removeAttribute("aria-busy");
  }
}

function renderPosts() {
  const list = $("post-list");
  list.replaceChildren();
  $("empty-posts").classList.toggle("hidden", state.posts.length > 0);
  $("empty-posts").textContent = state.searchQuery ? "검색 결과가 없습니다." : "등록된 게시물이 없습니다.";
  const firstNumber = state.totalPosts - (state.page - 1) * state.pageSize;
  state.posts.forEach((post, index) => {
    const commentCount = Number(post.comments?.[0]?.count ?? 0);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "post-row";
    row.innerHTML = `
      <span class="meta">${firstNumber - index}</span>
      <span class="post-title"><span>${escapeHtml(post.title)}</span>${commentCount > 0 ? `<span class="comment-badge" aria-label="댓글과 답글 ${commentCount}개">[${commentCount}]</span>` : ""}</span>
      <span class="meta">${escapeHtml(post.author_name)}</span>
      <span class="meta date">${formatDate(post.created_at)}${wasUpdated(post.created_at, post.updated_at) ? '<small class="edited-label">수정됨</small>' : ""}</span>
      <span class="meta views">${post.view_count}</span>`;
    row.addEventListener("click", () => openPost(post.id));
    list.append(row);
  });
}

function renderPagination() {
  const totalPages = Math.max(1, Math.ceil(state.totalPosts / state.pageSize));
  $("page-status").textContent = `${state.page} / ${totalPages} 페이지 · 총 ${state.totalPosts}개`;
  $("prev-page-button").disabled = state.page <= 1;
  $("next-page-button").disabled = state.page >= totalPages;
  $("pagination").classList.toggle("hidden", state.totalPosts === 0);
}

async function openPost(id) {
  const { data: post, error } = await supabase.from("posts").select("*").eq("id", id).single();
  if (error) return showToast(errorMessage(error, "게시물을 불러오지 못했습니다."), true);
  const { data: count, error: countError } = await supabase.rpc("increment_post_view", { p_post_id: id });
  if (!countError && Number.isInteger(count)) post.view_count = count;
  state.activePost = post;
  $("detail-title").textContent = post.title;
  $("detail-author").textContent = post.author_name;
  $("detail-date").textContent = wasUpdated(post.created_at, post.updated_at)
    ? `작성 ${formatDate(post.created_at, true)} · 수정 ${formatDate(post.updated_at, true)}`
    : formatDate(post.created_at, true);
  $("detail-views").textContent = post.view_count;
  $("detail-content").innerHTML = linkify(post.content);
  $("post-owner-actions").classList.toggle("hidden", !canManage(post.author_id));
  await loadComments(id);
  showView("detail-view");
}

async function loadComments(postId) {
  const { data, error } = await supabase.from("comments").select("*").eq("post_id", postId).order("created_at", { ascending: true });
  if (error) return showToast(errorMessage(error, "댓글을 불러오지 못했습니다."), true);
  state.comments = data || [];
  renderComments();
}

function commentElement(comment, reply = false) {
  const article = document.createElement("article");
  article.className = `comment${reply ? " reply" : ""}`;
  article.innerHTML = `
    <div class="comment-head"><div><span class="comment-author">${escapeHtml(comment.author_name)}</span><span class="comment-date">${formatDate(comment.created_at, true)}${wasUpdated(comment.created_at, comment.updated_at) ? " · 수정됨" : ""}</span></div></div>
    <div class="comment-body">${linkify(comment.content)}</div>
    <div class="comment-actions">
      ${!reply ? '<button type="button" data-action="reply">답글</button>' : ""}
      ${canManage(comment.author_id) ? '<button type="button" data-action="edit">수정</button><button type="button" data-action="delete">삭제</button>' : ""}
    </div>`;
  article.querySelector('[data-action="reply"]')?.addEventListener("click", () => openReplyForm(article, comment.id));
  article.querySelector('[data-action="edit"]')?.addEventListener("click", () => editComment(comment));
  article.querySelector('[data-action="delete"]')?.addEventListener("click", () => deleteComment(comment.id));
  return article;
}

function renderComments() {
  const list = $("comment-list");
  list.replaceChildren();
  $("comment-count").textContent = state.comments.length;
  $("empty-comments").classList.toggle("hidden", state.comments.length > 0);
  const roots = state.comments.filter((comment) => !comment.parent_id);
  roots.forEach((root) => {
    list.append(commentElement(root));
    state.comments.filter((comment) => comment.parent_id === root.id).forEach((reply) => list.append(commentElement(reply, true)));
  });
}

function openReplyForm(article, parentId) {
  document.querySelectorAll(".reply-form").forEach((form) => form.remove());
  const form = document.createElement("form");
  form.className = "reply-form";
  form.innerHTML = '<textarea maxlength="3000" required placeholder="답글을 입력하세요"></textarea><button class="primary-button" type="submit">답글 등록</button>';
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const content = form.querySelector("textarea").value.trim();
    if (!content) return;
    const submitButton = form.querySelector("button[type='submit']");
    setButtonLoading(submitButton, true, "등록 중…");
    const { error } = await supabase.from("comments").insert({ post_id: state.activePost.id, parent_id: parentId, content });
    if (error) {
      setButtonLoading(submitButton, false);
      return showToast(errorMessage(error, "답글을 등록하지 못했습니다."), true);
    }
    await loadComments(state.activePost.id);
  });
  article.append(form);
  form.querySelector("textarea").focus();
}

async function editComment(comment) {
  const content = window.prompt("댓글 내용을 수정하세요.", comment.content);
  if (content === null || !content.trim()) return;
  const { error } = await supabase.from("comments").update({ content: content.trim() }).eq("id", comment.id);
  if (error) return showToast(errorMessage(error, "댓글을 수정하지 못했습니다."), true);
  await loadComments(state.activePost.id);
}

async function deleteComment(id) {
  if (!window.confirm("이 댓글을 삭제하시겠습니까? 답글이 있으면 함께 삭제됩니다.")) return;
  const { error } = await supabase.from("comments").delete().eq("id", id);
  if (error) return showToast(errorMessage(error, "댓글을 삭제하지 못했습니다."), true);
  await loadComments(state.activePost.id);
}

function openEditor(post = null) {
  state.editingPostId = post?.id ?? null;
  state.editorReturnView = post ? "detail-view" : "list-view";
  const draft = post ? null : loadPostDraft();
  $("editor-title").textContent = post ? "게시글 수정" : "새 글 작성";
  $("post-title").value = post?.title ?? draft?.title ?? "";
  $("post-content").value = post?.content ?? draft?.content ?? "";
  state.editorInitial = { title: $("post-title").value, content: $("post-content").value };
  $("draft-status").textContent = post
    ? ""
    : draft
      ? "임시저장된 내용을 불러왔습니다."
      : "작성 내용은 자동으로 임시저장됩니다.";
  showView("editor-view");
  $("post-title").focus();
}

function editorHasChanges() {
  return state.editorInitial
    && (state.editorInitial.title !== $("post-title").value || state.editorInitial.content !== $("post-content").value);
}

function leaveEditor(destination = "list-view") {
  if (!editorHasChanges()) return showView(destination);
  if (state.editingPostId !== null) {
    if (!window.confirm("수정 중인 내용이 저장되지 않습니다. 나가시겠습니까?")) return;
  } else {
    window.clearTimeout(scheduleDraftSave.timer);
    savePostDraft();
    showToast("작성 내용이 임시저장되었습니다.");
  }
  showView(destination);
}

$("post-title").addEventListener("input", scheduleDraftSave);
$("post-content").addEventListener("input", scheduleDraftSave);

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("login-error").textContent = "";
  const loginId = $("login-id").value.trim().toLowerCase();
  const password = $("login-password").value;
  const submitButton = event.submitter;
  setButtonLoading(submitButton, true, "로그인 중…");
  try {
    const { error } = await supabase.auth.signInWithPassword({ email: `${loginId}@${LOGIN_DOMAIN}`, password });
    if (error) $("login-error").textContent = "아이디 또는 비밀번호를 확인해 주세요.";
  } finally {
    setButtonLoading(submitButton, false);
    $("login-password").value = "";
  }
});

$("logout-button").addEventListener("click", async () => {
  clearPostDraft();
  await supabase.auth.signOut();
});
$("home-button").addEventListener("click", async () => {
  if (!$("editor-view").classList.contains("hidden")) return leaveEditor("list-view");
  await loadPosts(1);
  showView("list-view");
});
$("new-post-button").addEventListener("click", () => openEditor());
$("cancel-post-button").addEventListener("click", () => leaveEditor(state.editorReturnView));
$("back-button").addEventListener("click", async () => { await loadPosts(state.page); showView("list-view"); });
$("edit-post-button").addEventListener("click", () => openEditor(state.activePost));

$("search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  state.searchQuery = sanitizedSearchQuery($("search-input").value);
  $("search-input").value = state.searchQuery;
  await loadPosts(1);
});
$("clear-search-button").addEventListener("click", async () => {
  $("search-input").value = "";
  state.searchQuery = "";
  await loadPosts(1);
});
$("prev-page-button").addEventListener("click", () => loadPosts(state.page - 1));
$("next-page-button").addEventListener("click", () => loadPosts(state.page + 1));

$("post-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const isNewPost = state.editingPostId === null;
  const values = { title: $("post-title").value.trim(), content: $("post-content").value.trim() };
  if (!values.title || !values.content) return showToast("제목과 내용을 입력해 주세요.", true);
  const submitButton = event.submitter;
  setButtonLoading(submitButton, true, "저장 중…");
  const query = state.editingPostId
    ? supabase.from("posts").update(values).eq("id", state.editingPostId).select().single()
    : supabase.from("posts").insert(values).select().single();
  const { data, error } = await query;
  if (error) {
    setButtonLoading(submitButton, false);
    return showToast(errorMessage(error, "게시글을 저장하지 못했습니다."), true);
  }
  setButtonLoading(submitButton, false);
  if (isNewPost) clearPostDraft();
  state.editingPostId = null;
  await openPost(data.id);
  showToast("게시글을 저장했습니다.");
});

$("delete-post-button").addEventListener("click", async () => {
  if (!window.confirm("이 게시글과 모든 댓글을 삭제하시겠습니까?")) return;
  const { error } = await supabase.from("posts").delete().eq("id", state.activePost.id);
  if (error) return showToast(errorMessage(error, "게시글을 삭제하지 못했습니다."), true);
  state.activePost = null;
  await loadPosts(state.page);
  showView("list-view");
  showToast("게시글을 삭제했습니다.");
});

$("comment-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const content = $("comment-content").value.trim();
  if (!content) return;
  const submitButton = event.submitter;
  setButtonLoading(submitButton, true, "등록 중…");
  const { error } = await supabase.from("comments").insert({ post_id: state.activePost.id, content });
  if (error) {
    setButtonLoading(submitButton, false);
    return showToast(errorMessage(error, "댓글을 등록하지 못했습니다."), true);
  }
  $("comment-content").value = "";
  await loadComments(state.activePost.id);
  setButtonLoading(submitButton, false);
});

supabase.auth.onAuthStateChange((_event, session) => {
  state.session = session;
  if (!session) {
    appInitialized = false;
    state.profile = null;
    $("app-view").classList.add("hidden");
    $("login-view").classList.remove("hidden");
    $("login-password").value = "";
    return;
  }
  if (appInitialized) return;
  appInitialized = true;
  window.setTimeout(async () => {
    try {
      await loadProfile();
      await loadPosts();
      $("login-view").classList.add("hidden");
      $("app-view").classList.remove("hidden");
      showView("list-view");
    } catch (error) {
      appInitialized = false;
      console.error(error);
      $("login-error").textContent = "등록되지 않은 계정이거나 게시판을 불러오지 못했습니다.";
      await supabase.auth.signOut();
    }
  }, 0);
});
