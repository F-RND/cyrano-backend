// Copyright 2026 Fimbriata R&D Services, LLC
// SPDX-License-Identifier: Apache-2.0

// Sanitization for user context attachments (POST /session/:id/attach).
// Same posture as sanitizeDefinitions in analysis/custom.ts: normalize
// client-supplied input into something safe to store and embed in a prompt —
// trim and clamp text, whitelist enums, drop anything malformed. The one
// attachment-specific rule: an image survives only when the destination is
// the agent. The analysis path being text-only is a shape the data cannot
// take server-side, not a convention the client is trusted to follow.

import {
  MAX_ATTACHMENT_IMAGE_B64_CHARS,
  MAX_ATTACHMENT_TEXT_CHARS,
  MAX_FILE_NAME_CHARS,
  type StoredAttachment,
  type UserContextItem,
} from "./types.js";

const MAX_APP_NAME_CHARS = 60;
const MAX_WINDOW_TITLE_CHARS = 120;

export type SanitizeResult =
  | { ok: true; attachment: StoredAttachment; imageBase64: string | null }
  | { ok: false; error: "invalid_attachment" | "attachment_too_large" };

export function sanitizeAttachment(raw: unknown): SanitizeResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "invalid_attachment" };
  }
  const a = raw as Record<string, unknown>;

  const id = typeof a.id === "string" ? a.id.trim().slice(0, 64) : "";
  const text =
    typeof a.text === "string" ? a.text.trim().slice(0, MAX_ATTACHMENT_TEXT_CHARS) : "";
  const destination =
    a.destination === "analysis" || a.destination === "agent" ? a.destination : null;
  const source =
    a.source === "clipboard" || a.source === "window" || a.source === "file" ? a.source : null;
  if (!id || !text || !destination || !source) {
    return { ok: false, error: "invalid_attachment" };
  }

  const appName =
    typeof a.app_name === "string" && a.app_name.trim()
      ? a.app_name.trim().slice(0, MAX_APP_NAME_CHARS)
      : undefined;
  const windowTitle =
    typeof a.window_title === "string" && a.window_title.trim()
      ? a.window_title.trim().slice(0, MAX_WINDOW_TITLE_CHARS)
      : undefined;
  const fileName =
    typeof a.file_name === "string" && a.file_name.trim()
      ? a.file_name.trim().slice(0, MAX_FILE_NAME_CHARS)
      : undefined;

  // Images ride only to the agent. For an analysis-destined attachment the
  // image is dropped, not rejected — the client already OCR'd it on-device,
  // so the text is the payload and a stray image field is not an error.
  let imageBase64: string | null = null;
  if (destination === "agent" && typeof a.image_base64 === "string" && a.image_base64.length > 0) {
    if (a.image_base64.length > MAX_ATTACHMENT_IMAGE_B64_CHARS) {
      return { ok: false, error: "attachment_too_large" };
    }
    imageBase64 = a.image_base64;
  }

  return {
    ok: true,
    attachment: {
      id,
      destination,
      source,
      text,
      ...(appName ? { app_name: appName } : {}),
      ...(windowTitle ? { window_title: windowTitle } : {}),
      ...(fileName ? { file_name: fileName } : {}),
      keep: a.keep === true,
      at: typeof a.at === "number" && Number.isFinite(a.at) ? a.at : 0,
      has_image: imageBase64 !== null,
      delivered_to_agent: false,
    },
    imageBase64,
  };
}

export function toUserContextItem(a: StoredAttachment): UserContextItem {
  return {
    source: a.source,
    ...(a.app_name ? { app_name: a.app_name } : {}),
    ...(a.window_title ? { window_title: a.window_title } : {}),
    ...(a.file_name ? { file_name: a.file_name } : {}),
    text: a.text,
  };
}
