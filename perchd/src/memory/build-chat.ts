/**
 * Build my memory, as Aside does it: an ordinary chat that researches the user across everything
 * Perch can reach and saves what it finds as it goes (memory_save never asks).
 */

export const MEMORY_BUILD_TITLE = "Build my memory";

export const MEMORY_BUILD_PROMPT = [
  "Research every single detail about me and save it to memory in an organized way.",
  "",
  "With the saved memory, you should be able to:",
  "- write messages in my tone and manner to my friends or colleagues",
  "- buy things from websites you haven't used for me before",
  "- review important documents and sign them",
  "",
  "Use everything you have: my browsing history (browsing_history); the sites I'm signed in to, such as my email (my sent mail for how I write, order and shipping emails for my addresses and sizes), my Google account, my calendar and account settings pages; the chats and memories saved in AI services I use (ChatGPT, Claude); what you already remember (memory_search); and web search for my public profiles. If a site needs me to sign in and 1Password is set up, sign in with it.",
  "",
  "Save each fact as you find it with memory_save, organized by category: about me, people, places and accounts, my writing style, and sites.",
  "",
  "Once you've gathered it all, score from 1 to 10 how well it covers the tasks above. If it's 9 or higher, finish. If not, find the missing parts and fill them in. At the end, ask me short questions about anything you couldn't find.",
  "",
  "It's fine to save my name, home address, phone number and ID details in plain text (memory is encrypted). Never save passwords, full card numbers or one-time codes.",
].join("\n");
