import data from "./proof.json";

export interface ProofItem {
  id: string;
  title: string;
  what: string;
  amount: string | null;
  at: string;
  status: string;
  ids: Array<{ label: string; value: string }>;
  log: string;
}

export const PROOF_NOTE: string = data.note;
export const PROOF_ITEMS: ProofItem[] = data.items;
/** Where each spike log lives on GitHub. */
export const proofLogUrl = (log: string): string => `${data.repo_blob}${log}`;
