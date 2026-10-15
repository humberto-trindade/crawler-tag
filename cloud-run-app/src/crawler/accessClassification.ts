export type AccessClassification = "challenge_detected" | "blocked_by_waf";

export const classifyBlockedNavigation = (
  statusCode: number,
  title: string,
  html: string,
): AccessClassification => {
  const content = `${title}\n${html}`.toLowerCase();
  if (
    /just a moment|checking your browser|verify you are human|human verification|verifica[çc][aã]o humana|__cf_chl|cf-chl|challenge-platform|captcha|turnstile/.test(content)
  ) {
    return "challenge_detected";
  }
  return "blocked_by_waf";
};
