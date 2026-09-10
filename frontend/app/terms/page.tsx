import type { Metadata } from "next"

import { LegalPage } from "@/components/marketing/legal-page"
import { MINUTE_PACKS, SIGNUP_GRANT_MINUTES } from "@/lib/billing"

/**
 * Terms of use. Written against the code, not against a template: every claim
 * here is one the product actually keeps today (metering per second of
 * conversation, free holds, non-expiring minutes, one Clerk account per
 * person) or is explicitly marked as unsettled.
 *
 * DRAFT — the `draft` flag renders the "under review" line. Open decisions
 * left for Yash, all marked inline as "(to set)":
 *   1. Refund window and terms (drafted as 14 days, unused minutes only).
 *   2. Contact address — `hello@` has no domain yet.
 *   3. Governing law / jurisdiction.
 * Remove `draft` and the "(to set)" markers once those are settled.
 */
export const metadata: Metadata = {
  title: "Terms",
  description: "The terms you agree to when you use tutor.",
}

export default function TermsPage() {
  const smallestPack = MINUTE_PACKS[0].minutes

  return (
    <LegalPage title="Terms" lastUpdated="2026-08-25" draft>
      <p>
        These terms cover your use of tutor. By making an account or using the
        service, you agree to them. We&rsquo;ve tried to write them the way we
        write everything else here: plainly, and only about things we actually
        do.
      </p>

      <h2>What tutor is</h2>
      <p>
        tutor is live voice conversation practice with an AI language tutor. You
        speak, it listens and replies, and the interface shows you your words
        and how to say them better. It is software, not a person. It is not a
        teacher, a translator you should rely on, or a source of advice of any
        kind. Like any AI system it can be wrong &mdash; it can mishear you,
        correct something that was already right, or say something inaccurate
        with complete confidence. Use it to practise, not as an authority.
      </p>

      <h2>Your account</h2>
      <p>
        Accounts are handled by Clerk, our sign-in provider. One account is for
        one person: don&rsquo;t share it, sell it, or let someone else use your
        minutes. You&rsquo;re responsible for what happens under your account,
        and for keeping your sign-in secure. You can delete your account at any
        time (see the privacy policy for what that removes).
      </p>

      <h2>Minutes</h2>
      <ul>
        <li>
          Conversation is metered by the second. The clock counts the time you
          are actually in a conversation, rounded to whole seconds, and your
          balance is reduced by that amount.
        </li>
        <li>
          Pausing is free. When you hold the session to read the transcript,
          look something up, review material or ask a question, the meter stops.
          Everything in the study surface is free to use.
        </li>
        <li>
          New accounts get {SIGNUP_GRANT_MINUTES} free minutes. That grant is
          once per person, not once per email address.
        </li>
        <li>
          Minutes are sold in packs, starting at {smallestPack} minutes. They
          never expire, and there is no subscription or recurring charge.
        </li>
        <li>
          Minutes are tied to your account. They can&rsquo;t be transferred,
          given away, or exchanged for money.
        </li>
        <li>
          Prices are shown before you buy and may change; a change never affects
          minutes you already own.
        </li>
      </ul>

      <h2>Refunds</h2>
      <p>
        Unused purchased minutes are refundable within 14 days of purchase if
        you ask us. Minutes you have already spoken through aren&rsquo;t
        refundable &mdash; the conversation cost real money to run. Free minutes
        have no cash value and are never refundable. (Refund window and terms:
        to set.)
      </p>

      <h2>Using it fairly</h2>
      <p>Please don&rsquo;t:</p>
      <ul>
        <li>
          use tutor to harass anyone, or to generate abusive, illegal or harmful
          content;
        </li>
        <li>
          access the service with bots, scripts or automated clients, or resell
          it as your own;
        </li>
        <li>
          interfere with the meter &mdash; tampering with the session clock, the
          balance, or the tokens that authorize a conversation;
        </li>
        <li>
          attempt to break, overload, or reverse-engineer the service, or work
          around its limits.
        </li>
      </ul>
      <p>
        If you do, we may suspend or close your account. Where the reason
        isn&rsquo;t abuse or non-payment, we&rsquo;ll refund unused purchased
        minutes.
      </p>

      <h2>Availability</h2>
      <p>
        tutor is provided as it is, without warranties of any kind. We
        don&rsquo;t promise it will always be available, that a conversation
        will never drop, or that what the tutor says will be correct. Parts of
        it depend on services we don&rsquo;t run, and those can fail. If a
        conversation fails on our side, tell us and we&rsquo;ll put the minutes
        back.
      </p>

      <h2>Liability</h2>
      <p>
        To the extent the law allows, we aren&rsquo;t liable for indirect or
        consequential losses, and our total liability to you is limited to what
        you&rsquo;ve paid us in the twelve months before the claim. Nothing here
        limits liability that can&rsquo;t legally be limited.
      </p>

      <h2>Ending things</h2>
      <p>
        You can stop using tutor and delete your account whenever you like. We
        may close an account that breaks these terms, or discontinue the service
        &mdash; if we discontinue it, we&rsquo;ll refund unused purchased
        minutes.
      </p>

      <h2>Changes</h2>
      <p>
        We may update these terms. The date at the top always says when they
        last changed, and if a change matters we&rsquo;ll tell you before it
        takes effect. Continuing to use tutor after that means you accept the
        new version.
      </p>

      <h2>Law</h2>
      <p>
        These terms are governed by the laws of the place we operate from, and
        disputes go to the courts there. (Governing law and jurisdiction: to
        set.)
      </p>

      <h2>Contact</h2>
      <p>
        Questions, refunds, or anything else: email us at hello@ (address: to
        set).
      </p>
    </LegalPage>
  )
}
