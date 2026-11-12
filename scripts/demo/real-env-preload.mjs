/**
 * Preload for the real-mode video recorder (scripts/demo/record-video-real.mjs): `node --env-file=.env --import <this>`.
 * The treasury payee is the sandbox buyer account from the env file; the value is copied in-process and never printed.
 */
const e = process.env;
if (!e.PAYPAL_SANDBOX_BUYER_EMAIL) throw new Error("real-env-preload: PAYPAL_SANDBOX_BUYER_EMAIL is not set in the env file");
e.TREASURY_PAYEE_EMAIL = e.PAYPAL_SANDBOX_BUYER_EMAIL;
