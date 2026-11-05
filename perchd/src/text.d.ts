/** Markdown files imported as text (Bun's `with { type: "text" }`), such as skills and guides. */
declare module "*.md" {
  const text: string;
  export default text;
}
