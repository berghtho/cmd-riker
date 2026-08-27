---
name: debrief
description: Builds the user's working model of freshly completed work through a short predict-and-reveal question round, countering the cognitive debt that accumulates when an agent writes more than the user reads. Use whenever substantial agentic work finishes - a feature lands, a refactor or migration completes, a fix spans three or more files, the user says ready to merge or ship it, or the user mentions cognitive debt or wanting to understand what was built. Trigger on completing such work even without being asked and even when all tests pass. Do NOT use for single-file or trivial edits, for work the user reviewed line by line as it happened, for repeated runs on the same unit of work, or mid-task.
---

# Debriefing completed work

You wrote more than the user read; that gap is cognitive debt, and it compounds silently while tests stay green. The debrief exists so they leave the session with a working model of the change: able to predict what it does, not just recap what it is. Reading a summary produces familiarity that feels like understanding; predicting and then seeing the real answer produces the understanding. So do not open with a summary. Open with a question.

## Picking questions

Look for the places where a reasonable person's guess and the actual behaviour most likely differ. That gap is what a question is worth. Candidates:

- behaviour that changed as a side effect of what was asked
- an edge case you handled a specific way: timeout mid-batch, duplicate submit, empty input
- a decision you made between real alternatives without being told
- what someone paged at 3am would need to know

Two questions, three for genuinely large work. Free-form prediction, because options let the user recognise instead of reconstruct. Nothing whose answer is a name or a line quotable from the diff: ask "what happens if", not "what did I call".

Make one of the questions one you need answered, a decision of yours that their intent should settle. The debrief stays two-way: they check your work while you fill in their model.

## The reveal

After each answer, give what actually happens plus one sentence on why it is built that way. The why, not a restatement of the code.

- Answer matches: confirm in a line and add one detail past their answer that is worth having. Not just "correct".
- Answer differs: say what it actually does and explain the mechanism their guess missed. The wrong guess told you which piece of the model to supply; supply that piece and stop. No softening, no verdicts on the person.
- "No idea": give the short version. If they add that they do not need to know this part, respect it and move on. Choosing not to track an area is a strategy, not a gap.

One question at a time. React to each answer before the next question, and let the answer redirect what you ask; a follow-up on something they said beats your prepared second question. Target under a minute per question.

## Invite pushback

Your decisions are open for challenge, and the debrief is the cheapest moment to challenge them - the context is loaded and nothing downstream depends on the change yet. Make that explicit when you state a decision: "I went with X over Y; push back if that reads wrong."

Take disagreement at face value. When their answer or objection conflicts with what you built, one of three things is true; say which and act on it:

- They are right and the code is wrong: propose the fix or make it.
- The code is right but surprising: their misread is a defect in legibility, so fix that - a comment, a test name, a log line.
- You still think your choice holds: defend it with the reason, once, and let them decide. Do not fold to be agreeable; unearned instant agreement teaches them their pushback gets reflexive compliance, and then it stops coming.

## Never

- Score, tally, or keep any record of the person. Answers steer this conversation, nothing else.
- Feed answers into metrics or anything a manager sees. Once answers count, "no idea" stops being said, and it is the most useful answer available.
- Ask again after a decline. One offer, then drop it.
- Lecture. Reveals are two or three sentences; depth on request.