"use client";

import { createContext, useContext } from "react";
import { useSearchParams } from "next/navigation";
import type { ShellAgent } from "@/lib/shell";

/** What the server already knows on first paint, so the sidebar and top bar never flash "Connecting…" or "Checking connection…". */
export interface ShellInitial {
  workspace: WorkspaceView | null;
  agents: ShellAgent[] | null;
  inbox: Array<{ agent_name: string }> | null;
  /** REINS_TRY=1: an offline judge instance. Known at render time, no fetch needed. */
  judge: boolean;
}

export interface WorkspaceView {
  name?: string;
  paypal_env: string;
  merchant_email: string | null;
  payment_mode: string;
  has_vault: boolean;
  telegram_linked: boolean;
  judge_mode?: boolean;
  connected_at: string | null;
}

export const EMPTY_SHELL: ShellInitial = { workspace: null, agents: null, inbox: null, judge: false };
export const ShellData = createContext<ShellInitial>(EMPTY_SHELL);
export const useShellInitial = () => useContext(ShellData);

/** The Overview "Include playground requests" toggle lives in the URL (?playground=1); the sidebar follows it. */
export function useIncludePlayground(): boolean {
  return useSearchParams().get("playground") === "1";
}
