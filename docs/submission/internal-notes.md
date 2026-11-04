# Internal notes (not for the Devpost form)

Do not paste this file into Devpost.

## APIMatic sponsor prize

**Do not tick this box unless the evidence below exists.** Repo search found APIMatic only in planning docs (docs/plan.md, issues #21 and #41): the plan was to develop with Claude Code plus the APIMatic PayPal Context Plugin (`npx context-plugins install paypal`) and document it in a README section and the commit log. There is no APIMatic usage recorded in the code, commit history or README, and Reins calls PayPal over plain REST, not the PayPal Server SDK. To claim it honestly we need: install the plugin, use it for at least one real task (for example generating or checking the Orders v2 / Payouts calls), commit a short "Built with the APIMatic Context Plugin" note with what it changed, then paste that into this paragraph.

Draft paragraph (use only after that is done): "We developed Reins with Claude Code and the APIMatic PayPal Context Plugin, which gave the coding agent accurate PayPal API context while we wrote the Orders v2 vault flow and Payouts client. Notes and examples are in the README section 'Built with APIMatic'."
