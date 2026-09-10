import type { Metadata } from "next"

import { LegalPage } from "@/components/marketing/legal-page"

/**
 * Privacy policy. Written from the schema, not from a template: every item in
 * "What we keep" is a field that actually exists on `users`, `creditLedger`
 * or `sessions` in `convex/schema.ts`, and the "we don't record audio" claim
 * is true because nothing in the worker or the token route ever asks LiveKit
 * for egress — the room config is built server-side and the client's
 * `room_config` is ignored (`app/api/token/route.ts`). If either of those
 * changes, this page changes with it.
 *
 * DRAFT — the `draft` flag renders the "under review" line. Open decisions
 * left for Yash, all marked inline as "(to set)":
 *   1. Contact address — `hello@` has no domain yet.
 *   2. Minimum age — drafted as 16.
 *   3. The payment provider, named once it's chosen.
 * Remove `draft` and the "(to set)" markers once those are settled.
 */
export const metadata: Metadata = {
  title: "Privacy",
  description: "What tutor collects, what it keeps, and what it never records.",
}

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy" lastUpdated="2026-08-25" draft>
      <p>
        This explains what tutor collects, why, and what happens to it. The
        short version: we keep the text of your conversations so the product can
        teach you from them, we never keep the audio, and we don&rsquo;t sell
        anything to anyone.
      </p>

      <h2>We don&rsquo;t record your audio</h2>
      <p>
        Your voice is not recorded and not stored. While you&rsquo;re speaking,
        the audio streams live to our speech providers &mdash; so your words can
        be transcribed and the tutor can answer &mdash; and then it is gone.
        There is no recording to play back, download, or hand over: we never
        made one.
      </p>

      <h2>What we keep</h2>
      <p>Your account:</p>
      <ul>
        <li>your email address, from your sign-in;</li>
        <li>the level you tell us you&rsquo;re at, and your languages;</li>
        <li>your minute balance, as a record of each grant and each debit.</li>
      </ul>
      <p>Your conversations. For each session we store:</p>
      <ul>
        <li>
          the transcript &mdash; the text of what you said and what the tutor
          said, up to the most recent 200 turns;
        </li>
        <li>
          the corrections, which include your own words as you said them
          alongside the better version;
        </li>
        <li>
          a one-line summary of what the conversation was about, and the goal
          you set for it;
        </li>
        <li>
          the review material generated for the session &mdash; vocabulary,
          phrases, conjugation tables;
        </li>
        <li>
          the questions you typed while paused, and the words you selected to
          translate.
        </li>
      </ul>
      <p>Usage:</p>
      <ul>
        <li>
          when a session started and ended, how many seconds were billed, why it
          ended, and roughly what it cost us to run.
        </li>
      </ul>
      <p>
        We keep this because it is the product: the summary, your history, and
        the tutor&rsquo;s sense of what you struggle with are all read back out
        of these records. We don&rsquo;t use them to train models.
      </p>

      <h2>Payments</h2>
      <p>
        When payments launch, card details will be handled entirely by our
        payment provider. We won&rsquo;t see or store your card number; we store
        only the fact that a purchase happened and the minutes it added to your
        balance.
      </p>

      <h2>Who else touches your data</h2>
      <ul>
        <li>
          <strong>Clerk</strong> &mdash; accounts and sign-in.
        </li>
        <li>
          <strong>Convex</strong> &mdash; the database everything above is
          stored in.
        </li>
        <li>
          <strong>LiveKit</strong> &mdash; real-time audio transport between you
          and the tutor.
        </li>
        <li>
          <strong>OpenAI</strong> &mdash; speech recognition, the tutor&rsquo;s
          voice, and the text models behind corrections, review and translation.
        </li>
        <li>
          <strong>Vercel</strong> &mdash; hosting for the website and its server
          routes.
        </li>
        <li>
          <strong>A payment provider</strong> &mdash; not yet chosen; named here
          before payments launch. (Provider: to set.)
        </li>
      </ul>
      <p>
        They process data on our behalf, for the purposes above and nothing
        else. Some of them are outside your country.
      </p>

      <h2>We don&rsquo;t sell it</h2>
      <p>
        We don&rsquo;t sell or rent your data, we don&rsquo;t run ads, and we
        don&rsquo;t share your conversations with anyone except the providers
        above. We&rsquo;d only hand data over if the law required it.
      </p>

      <h2>How long we keep it</h2>
      <p>
        Until you delete your account. There&rsquo;s no automatic expiry: your
        transcripts and corrections stay so your history stays.
      </p>

      <h2>Deleting your account</h2>
      <p>
        Delete your account from your account settings. Doing so removes your
        account record, your minute balance and its history, and your
        conversation records &mdash; transcripts, corrections, summaries, review
        material and everything else listed above. Unused minutes are forfeited
        when you delete, so ask for a refund first if you want one. Deletion is
        permanent; we can&rsquo;t restore a deleted account. Backups may hold
        copies for a short period before they roll over.
      </p>

      <h2>Your rights</h2>
      <p>
        You can ask for a copy of what we hold about you, ask us to correct it,
        or ask us to delete it, by emailing the address below. Depending on
        where you live you may have further rights over how your data is used;
        the same address is where to exercise them.
      </p>

      <h2>Children</h2>
      <p>
        tutor isn&rsquo;t for people under 16. We don&rsquo;t knowingly collect
        data from them, and we&rsquo;ll delete an account if we learn it belongs
        to one. (Minimum age: to set.)
      </p>

      <h2>Changes</h2>
      <p>
        If what we collect or who processes it changes, this page changes first,
        and the date at the top moves. If a change is significant we&rsquo;ll
        tell you.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about any of this, or a request about your data: email hello@
        (address: to set).
      </p>
    </LegalPage>
  )
}
