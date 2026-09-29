import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, LOGIN_DOMAIN } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const state = { session: null, profile: null, posts: [], activePost: null, comments: [], editingPostId: null };
const $ = (id) => document.getElementById(id);
const views = ["list-view", "editor-view", "detail-view"];

function showToast(message, isError = false) {
  const toast = $("toast");
  toast.textContent = message;
  toast.style.background = isError ? "#9f3535" : "#163c32";
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2600);
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

function canManage(authorId) {
  return state.profile?.is_admin || authorId === state.session?.user?.id;
}

async function loadProfile() {
  const { data, error } = await supabase.from("profiles").select("id, username, display_name, is_admin").eq("id", state.session.user.id).single();
  if (error) throw error;
  state.profile = data;
  $("current-user").textContent = `${data.display_name}${data.is_admin ? " · 관리자" : ""}`;
}

async function loadPosts() {
  const { data, error } = await supabase
    .from("posts")
    .select("id, title, author_id, author_name, view_count, created_at, updated_at, comments(count)")
    .order("id", { ascending: false })
    .limit(200);
  if (error) throw error;
  state.posts = data || [];
  renderPosts();
}

function renderPosts() {
  const list = $("post-list");
  list.replaceChildren();
  $("empty-posts").classList.toggle("hidden", state.posts.length > 0);
  state.posts.forEach((post, index) => {
    const commentCount = Number(post.comments?.[0]?.count ?? 0);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "post-row";
    row.innerHTML = `
      <span class="meta">${state.posts.length - index}</span>
      <span class="post-title"><span>${escapeHtml(post.title)}</span>${commentCount > 0 ? `<span class="comment-badge" aria-label="댓글과 답글 ${commentCount}개">[${commentCount}]</span>` : ""}</span>
      <span class="meta">${escapeHtml(post.author_name)}</span>
      <span class="meta date">${formatDate(post.created_at)}</span>
      <span class="meta views">${post.view_count}</span>`;
    row.addEventListener("click", () => openPost(post.id));
    list.append(row);
  });
}

async function openPost(id) {
  const { data: post, error } = await supabase.from("posts").select("*").eq("id", id).single();
  if (error) return showToast("게시물을 불러오지 못했습니다.", true);
  const { data: count } = await supabase.rpc("increment_post_view", { p_post_id: id });
  post.view_count = count ?? post.view_count;
  state.activePost = post;
  $("detail-title").textContent = post.title;
  $("detail-author").textContent = post.author_name;
  $("detail-date").textContent = formatDate(post.created_at, true);
  $("detail-views").textContent = post.view_count;
  $("detail-content").innerHTML = linkify(post.content);
  $("post-owner-actions").classList.toggle("hidden", !canManage(post.author_id));
  await loadComments(id);
  showView("detail-view");
}

async function loadComments(postId) {
  const { data, error } = await supabase.from("comments").select("*").eq("post_id", postId).order("created_at", { ascending: true });
  if (error) return showToast("댓글을 불러오지 못했습니다.", true);
  state.comments = data || [];
  renderComments();
}

function commentElement(comment, reply = false) {
  const article = document.createElement("article");
  article.className = `comment${reply ? " reply" : ""}`;
  article.innerHTML = `
    <div class="comment-head"><div><span class="comment-author">${escapeHtml(comment.author_name)}</span><span class="comment-date">${formatDate(comment.created_at, true)}</span></div></div>
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
    const { error } = await supabase.from("comments").insert({ post_id: state.activePost.id, parent_id: parentId, content });
    if (error) return showToast("답글을 등록하지 못했습니다.", true);
    await loadComments(state.activePost.id);
  });
  article.append(form);
  form.querySelector("textarea").focus();
}

async function editComment(comment) {
  const content = window.prompt("댓글 내용을 수정하세요.", comment.content);
  if (content === null || !content.trim()) return;
  const { error } = await supabase.from("comments").update({ content: content.trim() }).eq("id", comment.id);
  if (error) return showToast("댓글을 수정하지 못했습니다.", true);
  await loadComments(state.activePost.id);
}

async function deleteComment(id) {
  if (!window.confirm("이 댓글을 삭제하시겠습니까? 답글이 있으면 함께 삭제됩니다.")) return;
  const { error } = await supabase.from("comments").delete().eq("id", id);
  if (error) return showToast("댓글을 삭제하지 못했습니다.", true);
  await loadComments(state.activePost.id);
}

function openEditor(post = null) {
  state.editingPostId = post?.id ?? null;
  $("editor-title").textContent = post ? "게시글 수정" : "새 글 작성";
  $("post-title").value = post?.title ?? "";
  $("post-content").value = post?.content ?? "";
  showView("editor-view");
  $("post-title").focus();
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("login-error").textContent = "";
  const loginId = $("login-id").value.trim().toLowerCase();
  const password = $("login-password").value;
  const { error } = await supabase.auth.signInWithPassword({ email: `${loginId}@${LOGIN_DOMAIN}`, password });
  if (error) $("login-error").textContent = "아이디 또는 비밀번호를 확인해 주세요.";
});

$("logout-button").addEventListener("click", () => supabase.auth.signOut());
$("home-button").addEventListener("click", async () => { await loadPosts(); showView("list-view"); });
$("new-post-button").addEventListener("click", () => openEditor());
$("cancel-post-button").addEventListener("click", () => state.activePost ? showView("detail-view") : showView("list-view"));
$("back-button").addEventListener("click", async () => { await loadPosts(); showView("list-view"); });
$("edit-post-button").addEventListener("click", () => openEditor(state.activePost));

$("post-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = { title: $("post-title").value.trim(), content: $("post-content").value.trim() };
  const query = state.editingPostId
    ? supabase.from("posts").update(values).eq("id", state.editingPostId).select().single()
    : supabase.from("posts").insert(values).select().single();
  const { data, error } = await query;
  if (error) return showToast("게시글을 저장하지 못했습니다.", true);
  state.editingPostId = null;
  await openPost(data.id);
  showToast("게시글을 저장했습니다.");
});

$("delete-post-button").addEventListener("click", async () => {
  if (!window.confirm("이 게시글과 모든 댓글을 삭제하시겠습니까?")) return;
  const { error } = await supabase.from("posts").delete().eq("id", state.activePost.id);
  if (error) return showToast("게시글을 삭제하지 못했습니다.", true);
  state.activePost = null;
  await loadPosts();
  showView("list-view");
  showToast("게시글을 삭제했습니다.");
});

$("comment-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const content = $("comment-content").value.trim();
  if (!content) return;
  const { error } = await supabase.from("comments").insert({ post_id: state.activePost.id, content });
  if (error) return showToast("댓글을 등록하지 못했습니다.", true);
  $("comment-content").value = "";
  await loadComments(state.activePost.id);
});

supabase.auth.onAuthStateChange(async (_event, session) => {
  state.session = session;
  if (!session) {
    state.profile = null;
    $("app-view").classList.add("hidden");
    $("login-view").classList.remove("hidden");
    $("login-password").value = "";
    return;
  }
  try {
    await loadProfile();
    await loadPosts();
    $("login-view").classList.add("hidden");
    $("app-view").classList.remove("hidden");
    showView("list-view");
  } catch (error) {
    console.error(error);
    showToast("게시판 초기화에 실패했습니다.", true);
  }
});
