// A posting as a feed gives it, before the search profile's filters (W5 feed adapters).
import type { FeedSource, SearchProfileFieldsBase } from "@bs-job-agents/shared";

export interface FeedPosting {
  source: FeedSource;
  /** Canonical posting URL on the board (the link back the boards' terms ask for). */
  url: string;
  title: string;
  company: string;
  companyWebsite: string | null;
  /** Where applicants may live, as the board states it ("Anywhere in the World", "USA, Canada"); "" when not stated. */
  regionText: string;
  /** Salary as shown, or built from the feed's numbers ("$80,000 – $200,000 a year"); null when not given. */
  salaryText: string | null;
  postedAt: string | null;
  /** The board's tags / category / skills, lowercased. */
  tags: string[];
  /** Full JD as readable text (HTML stripped). */
  jdText: string;
}

/** One request a feed adapter wants made. */
export interface FeedRequest {
  url: string;
  /** "json" or "rss" (what the parser expects). */
  format: "json" | "rss";
}

export interface FeedAdapter {
  source: FeedSource;
  /** The requests for one scan (one or a few; each is cached and rate-limited by the scanner). */
  requests(criteria: SearchProfileFieldsBase): FeedRequest[];
  /** Postings in one response body. Throws when the body is not this feed's format. */
  parse(body: string): FeedPosting[];
  /** How long a response may be reused (the board's own guidance: Remotive asks for ≤ 4 calls a day). */
  cacheTtlMs: number;
}

export class FeedFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedFormatError";
  }
}
