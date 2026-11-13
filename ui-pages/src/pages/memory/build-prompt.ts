/**
 * "Build my memory": a chat that researches the user the way Aside's memory setup does, with
 * everything the agent can reach. It sends this as the user's own message, so they see exactly
 * what Perch was asked to do. Findings go to the review draft (memory_propose), never straight
 * into memory: the user saves them from perch://memory#review.
 */
export const BUILD_MEMORY_PROMPT = [
  "Build my memory. Research everything useful about me and propose it for my memory, organized, so that you can:",
  "- write messages in my tone to my friends and colleagues",
  "- buy things for me from websites you haven't used for me before",
  "- fill in forms and review documents for me",
  "",
  "Use everything you can reach: my browsing history (browsing_history); the sites I'm signed in to, such as my email (my sent mail for how I write, order and shipping emails for my addresses and sizes), my Google account and documents, my calendar, account settings pages, and the memories saved in AI services I use (ChatGPT, Claude); what Perch already remembers (memory_search); and web search for my public profiles.",
  "",
  "Add what you find with memory_propose, one short fact at a time: about me, people, places and accounts, my writing style, and sites. Never propose passwords, full card numbers, one-time codes or ID numbers.",
  "",
  "When you've gathered it all, score from 1 to 10 how well it covers the three tasks above. If it's below 9, find what's missing and fill it in. Finish with the score, what you found, what's still missing, and a link for me to review the draft: perch://memory#review",
].join("\n");
