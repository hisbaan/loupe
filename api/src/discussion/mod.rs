//! A pull request's discussion on GitHub: the conversation, review threads and
//! submitted reviews, plus the writes a reviewer needs (comments, replies,
//! resolving threads, approving or requesting changes) and marking a draft
//! ready for review.
//!
//! Everything uses the requesting user's token, so GitHub decides what they may
//! read and write. Writes happen only on an explicit request from the user,
//! never from model output. Line comments go into the user's pending review on
//! GitHub, as they do on github.com, so a review in progress survives reloads
//! and can be finished on either site.

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, patch, post, put},
};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    auth::CurrentUser,
    error::{AppError, AppResult},
    github,
    pulls::is_github_name,
    state::AppState,
};

/// GitHub's limit on a comment body.
const MAX_BODY_CHARS: usize = 65_536;
const MAX_PATH_CHARS: usize = 4_096;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/repos/{owner}/{repo}/pulls/{number}/discussion", get(get_discussion))
        .route("/repos/{owner}/{repo}/pulls/{number}/comments", post(add_comment))
        .route(
            "/repos/{owner}/{repo}/pulls/{number}/line-comments",
            post(add_line_comment),
        )
        .route(
            "/repos/{owner}/{repo}/pulls/{number}/review",
            post(submit_review).delete(discard_review),
        )
        .route("/repos/{owner}/{repo}/pulls/{number}/ready", post(mark_ready))
        .route("/discussion/threads/{id}/replies", post(reply))
        .route("/discussion/threads/{id}/resolved", put(set_resolved))
        .route("/discussion/{kind}/{id}", patch(edit_comment).delete(delete_comment))
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all(deserialize = "camelCase", serialize = "snake_case"))]
struct Actor {
    login: String,
    avatar_url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all(deserialize = "camelCase", serialize = "snake_case"))]
struct Connection<T> {
    total_count: usize,
    /// Left out where only the count is wanted.
    #[serde(default = "Vec::new")]
    nodes: Vec<T>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all(deserialize = "camelCase", serialize = "snake_case"))]
struct Comment {
    id: String,
    body: String,
    created_at: String,
    url: String,
    viewer_can_update: bool,
    viewer_can_delete: bool,
    /// `None` for deleted accounts.
    author: Option<Actor>,
    /// Review comments only: `PENDING` while in the viewer's unsubmitted review.
    #[serde(default)]
    state: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all(deserialize = "camelCase", serialize = "snake_case"))]
struct Review {
    id: String,
    /// `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED` or `DISMISSED`.
    state: String,
    body: String,
    submitted_at: Option<String>,
    url: String,
    author: Option<Actor>,
    comments: Connection<Empty>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Empty {}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all(deserialize = "camelCase", serialize = "snake_case"))]
struct Thread {
    id: String,
    path: String,
    /// The line in the current diff; `None` when the thread is outdated.
    line: Option<u32>,
    start_line: Option<u32>,
    original_line: Option<u32>,
    /// `LEFT` (old) or `RIGHT` (new).
    diff_side: String,
    is_resolved: bool,
    is_outdated: bool,
    viewer_can_resolve: bool,
    viewer_can_unresolve: bool,
    viewer_can_reply: bool,
    comments: Connection<Comment>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingNode {
    id: String,
    viewer_did_author: bool,
    #[serde(default)]
    comments: Option<Connection<Empty>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ViewerReviewNode {
    state: String,
    commit: Option<Oid>,
}

#[derive(Debug, Deserialize)]
struct Oid {
    oid: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullNode {
    head_ref_oid: String,
    viewer_did_author: bool,
    review_decision: Option<String>,
    viewer_latest_review: Option<ViewerReviewNode>,
    locked: bool,
    comments: Connection<Comment>,
    reviews: Connection<Review>,
    pending: Connection<PendingNode>,
    review_threads: Connection<Thread>,
}

#[derive(Debug, Deserialize)]
struct RepoData<T> {
    repository: Option<RepoNode<T>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepoNode<T> {
    pull_request: Option<T>,
}

#[derive(Debug, Serialize)]
struct PendingReview {
    id: String,
    comments: usize,
}

/// The viewer's latest submitted review, so the page can show they've reviewed.
#[derive(Debug, Serialize)]
struct ViewerReview {
    /// `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED` or `DISMISSED`.
    state: String,
    /// The commit it was submitted on.
    commit_sha: Option<String>,
}

#[derive(Debug, Serialize)]
struct Discussion {
    head_sha: String,
    viewer_did_author: bool,
    /// `APPROVED`, `CHANGES_REQUESTED` or `REVIEW_REQUIRED`; `None` when the
    /// branch doesn't require reviews.
    review_decision: Option<String>,
    locked: bool,
    /// The viewer's unsubmitted review, if they started one here or on GitHub.
    pending_review: Option<PendingReview>,
    viewer_review: Option<ViewerReview>,
    /// The conversation, oldest first.
    comments: Vec<Comment>,
    /// Submitted reviews, oldest first.
    reviews: Vec<Review>,
    threads: Vec<Thread>,
    /// GitHub had more than Loupe fetched; the rest is only on github.com.
    truncated: bool,
}

const DISCUSSION_QUERY: &str = r#"
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      viewerDidAuthor
      reviewDecision
      viewerLatestReview { state commit { oid } }
      locked
      comments(last: 100) { totalCount nodes { ...issueComment } }
      reviews(last: 100, states: [APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED]) {
        totalCount
        nodes { id state body submittedAt url author { login avatarUrl } comments(first: 1) { totalCount } }
      }
      pending: reviews(first: 10, states: [PENDING]) {
        totalCount
        nodes { id viewerDidAuthor comments(first: 1) { totalCount } }
      }
      reviewThreads(first: 100) {
        totalCount
        nodes {
          id path line startLine originalLine diffSide isResolved isOutdated
          viewerCanResolve viewerCanUnresolve viewerCanReply
          comments(first: 50) { totalCount nodes { ...reviewComment } }
        }
      }
    }
  }
}
fragment issueComment on IssueComment {
  id body createdAt url viewerCanUpdate viewerCanDelete author { login avatarUrl }
}
fragment reviewComment on PullRequestReviewComment {
  id body createdAt url viewerCanUpdate viewerCanDelete state author { login avatarUrl }
}"#;

async fn get_discussion(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((owner, repo, number)): Path<(String, String, u64)>,
) -> AppResult<Json<Discussion>> {
    check_names(&owner, &repo)?;
    let token = github::user_token(&state, user.id).await?;
    let pull: PullNode = fetch(&state, &token, DISCUSSION_QUERY, &owner, &repo, number).await?;

    let truncated = pull.comments.total_count > pull.comments.nodes.len()
        || pull.reviews.total_count > pull.reviews.nodes.len()
        || pull.review_threads.total_count > pull.review_threads.nodes.len()
        || pull
            .review_threads
            .nodes
            .iter()
            .any(|t| t.comments.total_count > t.comments.nodes.len());
    let pending_review = pull
        .pending
        .nodes
        .into_iter()
        .find(|r| r.viewer_did_author)
        .map(|r| PendingReview {
            id: r.id,
            comments: r.comments.map_or(0, |c| c.total_count),
        });
    let viewer_review = pull
        .viewer_latest_review
        .filter(|r| r.state != "PENDING")
        .map(|r| ViewerReview {
            state: r.state,
            commit_sha: r.commit.map(|c| c.oid),
        });

    Ok(Json(Discussion {
        head_sha: pull.head_ref_oid,
        viewer_did_author: pull.viewer_did_author,
        review_decision: pull.review_decision,
        locked: pull.locked,
        pending_review,
        viewer_review,
        comments: pull.comments.nodes,
        reviews: pull.reviews.nodes,
        threads: pull.review_threads.nodes,
        truncated,
    }))
}

/// What a write needs to know about the pull request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullTarget {
    id: String,
    head_ref_oid: String,
    pending: Connection<PendingNode>,
}

impl PullTarget {
    fn pending_review(&self) -> Option<&str> {
        self.pending
            .nodes
            .iter()
            .find(|r| r.viewer_did_author)
            .map(|r| r.id.as_str())
    }
}

const TARGET_QUERY: &str = r#"
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id headRefOid
      pending: reviews(first: 10, states: [PENDING]) { totalCount nodes { id viewerDidAuthor } }
    }
  }
}"#;

/// Fetches the pull request a write is about. With `expected_head`, refuses if
/// commits were pushed since the user loaded the page: line numbers would no
/// longer match, and an approval would cover code they haven't seen.
async fn target(
    state: &AppState,
    token: &str,
    owner: &str,
    repo: &str,
    number: u64,
    expected_head: Option<&str>,
) -> AppResult<PullTarget> {
    let target: PullTarget = fetch(state, token, TARGET_QUERY, owner, repo, number).await?;
    if expected_head.is_some_and(|sha| sha != target.head_ref_oid) {
        return Err(AppError::Conflict(
            "This pull request has new commits since you loaded it. Reload to see them; pending comments are kept."
                .into(),
        ));
    }
    Ok(target)
}

async fn fetch<T: serde::de::DeserializeOwned>(
    state: &AppState,
    token: &str,
    query: &str,
    owner: &str,
    repo: &str,
    number: u64,
) -> AppResult<T> {
    let variables = json!({ "owner": owner, "name": repo, "number": number });
    let response = github::graphql::<RepoData<T>>(state, token, query, variables).await?;
    for error in &response.errors {
        tracing::warn!(kind = ?error.kind, "loading pull request discussion: {}", error.message);
    }
    // Missing access looks the same as a missing pull request.
    response
        .data
        .and_then(|d| d.repository)
        .and_then(|r| r.pull_request)
        .ok_or(AppError::NotFound)
}

#[derive(Deserialize)]
struct BodyRequest {
    body: String,
}

/// A comment on the pull request's conversation.
async fn add_comment(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((owner, repo, number)): Path<(String, String, u64)>,
    Json(request): Json<BodyRequest>,
) -> AppResult<StatusCode> {
    check_names(&owner, &repo)?;
    let body = check_body(&request.body)?;
    let token = github::user_token(&state, user.id).await?;
    // Pull requests are issues; their conversation is the issue's comments.
    let path = format!("/repos/{owner}/{repo}/issues/{number}/comments");
    github::send_json::<Value>(&state, &token, Method::POST, &path, &json!({ "body": body })).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Side {
    Old,
    New,
}

impl Side {
    fn github(self) -> &'static str {
        match self {
            Side::Old => "LEFT",
            Side::New => "RIGHT",
        }
    }
}

#[derive(Deserialize)]
struct LineCommentRequest {
    /// The head commit the user commented on.
    head_sha: String,
    path: String,
    side: Side,
    start_line: u32,
    end_line: u32,
    body: String,
    /// Add to the user's pending review instead of posting right away.
    review: bool,
}

async fn add_line_comment(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((owner, repo, number)): Path<(String, String, u64)>,
    Json(request): Json<LineCommentRequest>,
) -> AppResult<StatusCode> {
    check_names(&owner, &repo)?;
    let body = check_body(&request.body)?;
    if request.path.is_empty() || request.path.len() > MAX_PATH_CHARS {
        return Err(AppError::BadRequest("invalid path".into()));
    }
    if request.start_line == 0 || request.start_line > request.end_line {
        return Err(AppError::BadRequest("invalid line range".into()));
    }
    let token = github::user_token(&state, user.id).await?;
    let target = target(&state, &token, &owner, &repo, number, Some(&request.head_sha)).await?;

    let side = request.side.github();
    let multi_line = request.start_line < request.end_line;
    if !request.review {
        let mut comment = json!({
            "body": body,
            "commit_id": target.head_ref_oid,
            "path": request.path,
            "line": request.end_line,
            "side": side,
        });
        if multi_line {
            comment["start_line"] = json!(request.start_line);
            comment["start_side"] = json!(side);
        }
        let path = format!("/repos/{owner}/{repo}/pulls/{number}/comments");
        github::send_json::<Value>(&state, &token, Method::POST, &path, &comment).await?;
        return Ok(StatusCode::NO_CONTENT);
    }

    let mut thread = json!({ "path": request.path, "line": request.end_line, "side": side, "body": body });
    if multi_line {
        thread["startLine"] = json!(request.start_line);
        thread["startSide"] = json!(side);
    }
    match target.pending_review() {
        Some(review) => {
            thread["pullRequestReviewId"] = json!(review);
            github::mutate::<Value>(
                &state,
                &token,
                "mutation($input: AddPullRequestReviewThreadInput!) { addPullRequestReviewThread(input: $input) { thread { id } } }",
                json!({ "input": thread }),
            )
            .await?;
        }
        // Without an event, the new review stays pending.
        None => {
            let input = json!({ "pullRequestId": target.id, "commitOID": target.head_ref_oid, "threads": [thread] });
            github::mutate::<Value>(
                &state,
                &token,
                "mutation($input: AddPullRequestReviewInput!) { addPullRequestReview(input: $input) { pullRequestReview { id } } }",
                json!({ "input": input }),
            )
            .await?;
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ReviewEvent {
    Comment,
    Approve,
    RequestChanges,
}

impl ReviewEvent {
    fn github(self) -> &'static str {
        match self {
            ReviewEvent::Comment => "COMMENT",
            ReviewEvent::Approve => "APPROVE",
            ReviewEvent::RequestChanges => "REQUEST_CHANGES",
        }
    }
}

#[derive(Deserialize)]
struct SubmitRequest {
    /// The head commit the user reviewed.
    head_sha: String,
    event: ReviewEvent,
    #[serde(default)]
    body: String,
}

/// Submits the user's review, including their pending comments if any.
async fn submit_review(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((owner, repo, number)): Path<(String, String, u64)>,
    Json(request): Json<SubmitRequest>,
) -> AppResult<StatusCode> {
    check_names(&owner, &repo)?;
    let body = request.body.trim();
    if body.chars().count() > MAX_BODY_CHARS {
        return Err(AppError::BadRequest("that comment is too long for GitHub".into()));
    }
    let token = github::user_token(&state, user.id).await?;
    let target = target(&state, &token, &owner, &repo, number, Some(&request.head_sha)).await?;
    let event = request.event.github();

    match target.pending_review() {
        Some(review) => {
            let input = json!({ "pullRequestReviewId": review, "event": event, "body": body });
            github::mutate::<Value>(
                &state,
                &token,
                "mutation($input: SubmitPullRequestReviewInput!) { submitPullRequestReview(input: $input) { pullRequestReview { id } } }",
                json!({ "input": input }),
            )
            .await?;
        }
        None => {
            if body.is_empty() && !matches!(request.event, ReviewEvent::Approve) {
                return Err(AppError::BadRequest("write a comment to go with your review".into()));
            }
            let input =
                json!({ "pullRequestId": target.id, "commitOID": target.head_ref_oid, "event": event, "body": body });
            github::mutate::<Value>(
                &state,
                &token,
                "mutation($input: AddPullRequestReviewInput!) { addPullRequestReview(input: $input) { pullRequestReview { id } } }",
                json!({ "input": input }),
            )
            .await?;
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Deletes the user's pending review and its comments.
async fn discard_review(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((owner, repo, number)): Path<(String, String, u64)>,
) -> AppResult<StatusCode> {
    check_names(&owner, &repo)?;
    let token = github::user_token(&state, user.id).await?;
    let target = target(&state, &token, &owner, &repo, number, None).await?;
    let review = target.pending_review().ok_or(AppError::NotFound)?;
    github::mutate::<Value>(
        &state,
        &token,
        "mutation($input: DeletePullRequestReviewInput!) { deletePullRequestReview(input: $input) { pullRequestReview { id } } }",
        json!({ "input": { "pullRequestReviewId": review } }),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ReadyRequest {
    /// The head commit the user saw.
    head_sha: String,
}

/// Takes a draft pull request out of draft. Pinned to the head commit on
/// screen, like a review: the user is vouching for what they've seen.
async fn mark_ready(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((owner, repo, number)): Path<(String, String, u64)>,
    Json(request): Json<ReadyRequest>,
) -> AppResult<StatusCode> {
    check_names(&owner, &repo)?;
    let token = github::user_token(&state, user.id).await?;
    let target = target(&state, &token, &owner, &repo, number, Some(&request.head_sha)).await?;
    github::mutate::<Value>(
        &state,
        &token,
        "mutation($input: MarkPullRequestReadyForReviewInput!) { markPullRequestReadyForReview(input: $input) { pullRequest { id } } }",
        json!({ "input": { "pullRequestId": target.id } }),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Replies right away, outside any pending review.
async fn reply(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(request): Json<BodyRequest>,
) -> AppResult<StatusCode> {
    check_node_id(&id)?;
    let body = check_body(&request.body)?;
    let token = github::user_token(&state, user.id).await?;
    github::mutate::<Value>(
        &state,
        &token,
        "mutation($input: AddPullRequestReviewThreadReplyInput!) { addPullRequestReviewThreadReply(input: $input) { comment { id } } }",
        json!({ "input": { "pullRequestReviewThreadId": id, "body": body } }),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct ResolvedRequest {
    resolved: bool,
}

async fn set_resolved(
    user: CurrentUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(request): Json<ResolvedRequest>,
) -> AppResult<StatusCode> {
    check_node_id(&id)?;
    let token = github::user_token(&state, user.id).await?;
    let query = if request.resolved {
        "mutation($input: ResolveReviewThreadInput!) { resolveReviewThread(input: $input) { thread { id } } }"
    } else {
        "mutation($input: UnresolveReviewThreadInput!) { unresolveReviewThread(input: $input) { thread { id } } }"
    };
    github::mutate::<Value>(&state, &token, query, json!({ "input": { "threadId": id } })).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `issue-comments` (the conversation) or `review-comments` (in threads).
fn comment_kind(kind: &str) -> AppResult<bool> {
    match kind {
        "issue-comments" => Ok(false),
        "review-comments" => Ok(true),
        _ => Err(AppError::NotFound),
    }
}

async fn edit_comment(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((kind, id)): Path<(String, String)>,
    Json(request): Json<BodyRequest>,
) -> AppResult<StatusCode> {
    let review_comment = comment_kind(&kind)?;
    check_node_id(&id)?;
    let body = check_body(&request.body)?;
    let token = github::user_token(&state, user.id).await?;
    let (query, input) = if review_comment {
        (
            "mutation($input: UpdatePullRequestReviewCommentInput!) { updatePullRequestReviewComment(input: $input) { pullRequestReviewComment { id } } }",
            json!({ "pullRequestReviewCommentId": id, "body": body }),
        )
    } else {
        (
            "mutation($input: UpdateIssueCommentInput!) { updateIssueComment(input: $input) { issueComment { id } } }",
            json!({ "id": id, "body": body }),
        )
    };
    github::mutate::<Value>(&state, &token, query, json!({ "input": input })).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_comment(
    user: CurrentUser,
    State(state): State<AppState>,
    Path((kind, id)): Path<(String, String)>,
) -> AppResult<StatusCode> {
    let review_comment = comment_kind(&kind)?;
    check_node_id(&id)?;
    let token = github::user_token(&state, user.id).await?;
    let query = if review_comment {
        "mutation($input: DeletePullRequestReviewCommentInput!) { deletePullRequestReviewComment(input: $input) { clientMutationId } }"
    } else {
        "mutation($input: DeleteIssueCommentInput!) { deleteIssueComment(input: $input) { clientMutationId } }"
    };
    github::mutate::<Value>(&state, &token, query, json!({ "input": { "id": id } })).await?;
    Ok(StatusCode::NO_CONTENT)
}

fn check_names(owner: &str, repo: &str) -> AppResult<()> {
    if is_github_name(owner) && is_github_name(repo) {
        Ok(())
    } else {
        Err(AppError::BadRequest("invalid owner or repo".into()))
    }
}

fn check_body(body: &str) -> AppResult<&str> {
    let body = body.trim();
    if body.is_empty() {
        return Err(AppError::BadRequest("the comment is empty".into()));
    }
    if body.chars().count() > MAX_BODY_CHARS {
        return Err(AppError::BadRequest("that comment is too long for GitHub".into()));
    }
    Ok(body)
}

/// GitHub node ids (`PRRT_kwDO…`); they're passed as GraphQL variables, so this
/// only keeps junk out.
fn check_node_id(id: &str) -> AppResult<()> {
    let valid = !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '='));
    if valid {
        Ok(())
    } else {
        Err(AppError::BadRequest("invalid id".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_discussion() {
        let pull: PullNode = serde_json::from_value(json!({
            "headRefOid": "abc",
            "viewerDidAuthor": false,
            "reviewDecision": null,
            "viewerLatestReview": { "state": "APPROVED", "commit": { "oid": "abc" } },
            "locked": false,
            "comments": { "totalCount": 1, "nodes": [{
                "id": "IC_1", "body": "hi", "createdAt": "2026-01-01T00:00:00Z", "url": "https://github.com/x",
                "viewerCanUpdate": true, "viewerCanDelete": true, "author": null
            }] },
            "reviews": { "totalCount": 0, "nodes": [] },
            "pending": { "totalCount": 1, "nodes": [
                { "id": "PRR_1", "viewerDidAuthor": true, "comments": { "totalCount": 2 } }
            ] },
            "reviewThreads": { "totalCount": 1, "nodes": [{
                "id": "PRRT_1", "path": "a.rs", "line": null, "startLine": null, "originalLine": 3,
                "diffSide": "RIGHT", "isResolved": false, "isOutdated": true,
                "viewerCanResolve": true, "viewerCanUnresolve": false, "viewerCanReply": true,
                "comments": { "totalCount": 1, "nodes": [{
                    "id": "PRRC_1", "body": "why?", "createdAt": "2026-01-01T00:00:00Z", "url": "https://github.com/y",
                    "viewerCanUpdate": false, "viewerCanDelete": false, "state": "SUBMITTED",
                    "author": { "login": "bob", "avatarUrl": null }
                }] }
            }] }
        }))
        .unwrap();
        assert_eq!(pull.pending.nodes[0].comments.as_ref().unwrap().total_count, 2);

        let thread = serde_json::to_value(&pull.review_threads.nodes[0]).unwrap();
        assert_eq!(thread["diff_side"], "RIGHT");
        assert_eq!(thread["comments"]["nodes"][0]["author"]["login"], "bob");
        assert_eq!(thread["comments"]["nodes"][0]["viewer_can_update"], false);
    }

    #[test]
    fn node_ids() {
        assert!(check_node_id("PRRT_kwDOAbc-12_3=").is_ok());
        assert!(check_node_id("").is_err());
        assert!(check_node_id("a b").is_err());
        assert!(check_node_id("../x").is_err());
    }
}
