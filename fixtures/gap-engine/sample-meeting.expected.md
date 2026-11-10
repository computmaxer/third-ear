# sample-meeting.txt: what a good run should find

A synthetic 21-minute meeting about automatically offering cancelled vet
appointments to clients on a waitlist. Dana is the subject matter expert
(clinic operations), Priya is the product manager, and Max is the engineer.
Replay it with `--me Max`. All names, clinics and numbers are invented.

Use this as the answer key when you read a replay report. A good run raises
most of the planted gaps below, at or soon after the time shown. It resolves
the answered ones once the answer is spoken, and raises nothing else. The
offline script (`sample-offline-script.json`) only exercises the engine's
rules. It is not a target for quality.

## Planted gaps

| ID | Kind | Planted | What is unclear | Answered |
|----|------|---------|-----------------|----------|
| A1 | ambiguity | 03:22 Dana: "we'd only offer it to people who are close by" | Close by means either waitlisted at that clinic or within a travel distance of it. Distance matching needs client locations. | Yes, 12:40. Dana: "when I said close by earlier, I just mean they're on the waitlist for that clinic." |
| A2 | ambiguity | 09:41 Dana: "obviously not for last-minute stuff" | No cutoff is given. Is it the same day, the next hour, or within some number of hours? The cutoff decides which cancellations the system handles. | No. Priya's "unless the slot's already passed" (18:20) is about quiet hours, not this cutoff. |
| U1 | unaddressed | 09:55 Priya describes offers going one client at a time, with fifteen minutes each | Nobody says what happens when a client replies YES after their fifteen minutes are up. Nobody says what happens when two clients reply for the same slot either. | Yes, 16:48. Priya: a late YES gets the slot if it is still free, otherwise a sorry text, and the client keeps their place. At 17:20, the case where two clients reply is also settled. |
| U2 | unaddressed | 04:24 Dana: a slot is vet time, and "Say a twenty minute slot with Doctor Okafor opens up at ten"; 06:38: appointment types run 15, 20, 40 and 60 minutes | Can a 20-minute slot go to someone waiting for an hour-long dental? Should matching check duration, or join neighbouring free slots? | No. |
| C1 | contradiction | 04:52 Dana: "we just send it to everybody on the waitlist at once and whoever says yes first gets the slot". 09:55 Priya: "the first person on the list gets the text, and if they haven't answered in fifteen minutes it moves on to the next person" | One says offers go to everyone at once. The other says they go one client at a time. This is the core offer flow. | Yes, 13:18 to 14:07. Dana notices the conflict and they agree: "Yes, one at a time, fifteen minutes each." |
| D1 | implicit_decision | 02:08 Priya: "It could be a text, could be an email, could be a push notification in the app" | From 07:07 everyone talks only about texts: the message template, the SMS provider, "one SMS segment" (10:54) and "reply YES". Nobody says that email and push are out. | No. |

A strong model should resolve A1, C1 and U1 after they are answered. It
should not raise them again later. While C1 is open, it might update C1
rather than raise a near-duplicate.

A2, U2 and D1 are never answered. With the default rules, A2 and U2 are
likely to end the meeting retired unanswered rather than open: a gap nobody
touches for 12 minutes goes stale, and one can be displaced by a more
important raise when three are open. Look for them in the summary's
"retired unanswered" list as well as "open at the end".

## Tempting false positives (should raise nothing)

- 01:21 and 07:40: Max asks how many cancellations there are, and whether
  phone numbers need confirming. Both are answered straight away, and the
  engineer asked them himself.
- 08:05: SMS consent. Dana says opted-out clients never get texts, using an
  existing PMS flag.
- 08:34: Dana says "Tuesdays, sorry, Wednesdays, the day before, um, no, two
  days before". This is a self-correction about the existing reminders, not a
  contradiction, and it is not part of the feature.
- 10:54 to 11:34: the SMS length limit and what to drop if the text does not
  fit. Both are settled in the conversation.
- 11:34: Dana says "Some people go to two" clinics. This is covered by each
  clinic having its own waitlist (12:40).
- 11:39 to 12:22: the weekly report is fully specified (Monday 8am, four
  counts, by vet). Max's own "clinic's local time I guess" is his stated
  assumption. At most it is a minor confirmation, not a gap worth showing.
- 14:31 to 15:28: front desk visibility. It is settled as notes on the
  appointment.
- 15:36: Spanish texts. These are explicitly out of scope.
- 15:58 to 16:25: how clients accept. They reply YES and get a confirmation
  text.
- 17:41 to 18:20: weekends and quiet hours. No texts outside 8am to 8pm; the
  offer waits.
- 18:31 to 20:20: the pilot. It runs at Riverside for two weeks, behind a
  per-clinic switch. Success means refill rate and complaints, and complaints
  need no tracking in the system.
- Generic concerns tied to nothing that was said, such as security, privacy,
  load, SMS cost or accessibility, should not be raised.
