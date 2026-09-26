// Swytchcode trust boundary: maps the plan's tool aliases to registry canonical IDs.
// Agents call tools by alias; only the IDs below are whitelisted in .swytchcode/tooling.json.

/** Integrations registered in tooling.json (`project.library` keys). */
export const REQUIRED_INTEGRATIONS = ['Notion.notion', 'Resend.resend', 'Twitter.twitter_v2'] as const;

/** Plan alias -> Swytchcode canonical ID. */
export const SWYTCHCODE_TOOLS = {
  'notion.create_page': 'notion.page.create',
  'notion.query_database': 'notion.query.create',
  'resend.send_email': 'resend.email.create',
  'x.create_tweet': 'twitter_v2.tweet.create',
} as const satisfies Record<string, string>;

export type ToolAlias = keyof typeof SWYTCHCODE_TOOLS;
