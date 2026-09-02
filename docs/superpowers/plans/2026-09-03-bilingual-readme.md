# Bilingual README Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Long Horizon Runtime immediately understandable to Chinese and English readers with matching, evidence-bounded README entry points.

**Architecture:** Keep `README.md` as the Chinese default entry point and add `README.en.md` as its English peer. Both files use the same short navigation and section order, link to each other, share the existing Task Cockpit image, and only make claims supported by the repository's validation contracts.

**Tech Stack:** Markdown, GitHub relative links, existing repository assets and validation scenarios.

**Spec:** User-approved in-chat design, 2026-09-03.

## Global Constraints

- `README.md` is Chinese-first and `README.en.md` is the matching English entry point.
- Use `master` in Git installation commands.
- Keep the captured DAG image labelled as visual product evidence, not passed UI acceptance.
- Preserve the existing safety and deterministic-validation limits in both languages.
- Do not modify plugin code, bundled defaults, or user-profile configuration.

---

### Task 1: Establish the bilingual README structure

**Files:**
- Modify: `README.md`
- Create: `README.en.md`

**Interfaces:**
- Produces reciprocal language links: `README.md` -> `README.en.md`, `README.en.md` -> `README.md`.
- Produces matching anchors for overview, capabilities, installation, normal-chat use, safety/evidence, and development.

- [ ] **Step 1: Replace the default entry with Chinese-first navigation and concise positioning**

Use a reciprocal language switch directly below the project title:

```markdown
中文 | [English](README.en.md)

> 让 DeepSeek Harness 中跨回合、可中断的多步骤工作，拥有可审计的持久状态。

[是什么](#是什么) · [核心能力](#核心能力) · [快速开始](#快速开始) · [安全与证据](#安全与证据) · [开发](#开发)
```

- [ ] **Step 2: Add the English peer with the same information architecture**

Use the equivalent English entry block:

```markdown
[中文](README.md) | English

> Durable, inspectable multi-step work for DeepSeek Harness chats.

[Overview](#overview) · [Capabilities](#capabilities) · [Quick start](#quick-start) · [Safety and evidence](#safety-and-evidence) · [Development](#development)
```

- [ ] **Step 3: Verify the language links and section anchors exist**

Run:

```powershell
rg -n "README\.en\.md|README\.md|## 什么是|## Overview|docs/assets/readme/task-dag-completed\.png" README.md README.en.md
```

Expected: both documents contain a reciprocal language link, their primary overview heading, and the same relative image path.

- [ ] **Step 4: Commit**

```powershell
git add README.md README.en.md
git commit -m "docs: add bilingual README entry points"
```

### Task 2: Preserve operational guidance and verifiable boundaries

**Files:**
- Modify: `README.md`, `README.en.md`

**Interfaces:**
- Both READMEs include identical install paths, normal-chat examples, strict-routing warning, and evidence links.

- [ ] **Step 1: Carry the supported install paths into both languages**

Include Git, local checkout, and built-tarball commands. The Git command must be:

```bash
dsh plugin --profile web add github:ynymhrb/long-horizon-runtime#master
dsh web
```

- [ ] **Step 2: Carry the safety constraints into both languages**

State that automatic replanning is limited to bounded unfinished `read_only` work, and that external effects, completed work, or deactivated verified artifacts require confirmation. Keep `30/30` explicitly scoped as deterministic scenario evidence, not live-LLM or manual UI acceptance.

- [ ] **Step 3: Verify the documentation and package checks**

Run:

```powershell
pnpm test
pnpm typecheck
pnpm build
pnpm pack --dry-run
git diff --check
```

Expected: all commands exit successfully. Restore only generated `dist/` changes before committing, if build rewrites them without source changes.

- [ ] **Step 4: Commit**

```powershell
git add README.md README.en.md
git commit -m "docs: clarify bilingual runtime guidance"
```
