/**
 * Build my memory, as Aside does it: an ordinary chat that researches the user across everything
 * Perch can reach and saves what it finds as it goes (memory_save never asks).
 */

export const MEMORY_BUILD_TITLE = "Build my memory";

const PURPOSE = [
  "With the saved memory, you should be able to:",
  "- write messages in my tone and manner to my friends or colleagues",
  "- buy things from websites you haven't used for me before",
  "- review important documents and sign them",
];

/** Where to look, how to save and when to stop: the same for a full build and for filling gaps. */
const METHOD = [
  "Use everything you have: my browsing history (browsing_history); the sites I'm signed in to, such as my email (my sent mail for how I write, order and shipping emails for my addresses and sizes), my Google account, my calendar and account settings pages; the chats and memories saved in AI services I use (ChatGPT, Claude); what you already remember (memory_search); and web search for my public profiles. If a site needs me to sign in, use sign_in (it uses my saved logins and 1Password).",
  "",
  "Save each fact as you find it with memory_save, organized by category: about me (category user), people, places and accounts, my writing style (category writing), and sites.",
  "",
  "Once you've gathered it all, score from 1 to 10 how well it covers the tasks above. If it's 9 or higher, finish. If not, find the missing parts and fill them in. At the end, ask me short questions about anything you couldn't find.",
  "",
  "It's fine to save my name, home address, phone number and the details on my ID in plain text (memory is encrypted). Never save passwords, PINs, security answers, full card or bank account numbers, or one-time codes.",
];

export const MEMORY_BUILD_PROMPT = ["Research every single detail about me and save it to memory in an organized way.", "", ...PURPOSE, "", ...METHOD].join("\n");

/**
 * The prompt when memory already holds a good deal (brought over from Aside, say): keep what's
 * there and research only what it lacks.
 */
export function memoryGapsPrompt(missing: readonly string[], facts: number): string {
  return [
    `My memory already has ${facts} facts about me. Search it (memory_search) first, and don't research again what it already covers. Fill in only what's missing:`,
    ...missing.map((m) => `- ${m}`),
    "",
    ...PURPOSE,
    "",
    ...METHOD,
  ].join("\n");
}
