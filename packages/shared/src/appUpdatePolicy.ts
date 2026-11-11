/** Fork policy: only an explicit source change may enable T3 Code application updates.
 * Provider CLI maintenance is independent and must not use this policy.
 */
export const APP_UPDATES_ENABLED: boolean = false;
export const APP_UPDATES_DISABLED_REASON =
  "Application update checks and automatic updates are disabled in this build.";
