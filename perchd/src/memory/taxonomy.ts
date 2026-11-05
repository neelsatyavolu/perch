/**
 * TAXONOMY.md (spec 8): the filing rules extraction, setup and the agent's memory_save follow.
 * The user can read and change it on the Memory page; this is the text it starts with. The
 * rules Perch enforces in code (standing rules need approval, secrets are refused) hold
 * whatever it says.
 */

export const TAXONOMY_PATH = "TAXONOMY.md";
export const MAX_TAXONOMY = 4000;

export const DEFAULT_TAXONOMY = [
  "Where facts go:",
  "- user: stable facts about the user (name, work, home city, preferences, habits). Saved in USER.md.",
  "- rules: standing instructions for the agent (\"never book Spirit\", \"reply in British English\"). Saved in MEMORY.md, only with the user's approval.",
  "- people: one page per person the user knows, titled with their name.",
  "- companies, places, sites, projects, concepts: one page per company, place, website, project or topic.",
  "- writing: how the user writes (tone, sign-off, length), titled by context such as \"Email\".",
  "- routines: things the user does regularly, titled by the routine.",
  "- episodic: dated events worth remembering for a while (\"booked the dentist for Nov 12\").",
  "Each fact is one short sentence that still makes sense on its own. File each fact once, in the most specific page.",
  "Use an existing page title when one fits. Add expires (YYYY-MM-DD) to facts that stop being true on a date.",
  "Never save passwords, keys, card numbers, one-time codes, health or financial account details, or anything the user asked to forget.",
].join("\n");
