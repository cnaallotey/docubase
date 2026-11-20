---
title: Answers that arrive as they are written
description: Ask AI now streams. How we built it with Server-Sent Events, and why closing the dialog stops the bill.
date: 2026-11-13
author: The Docubase team
---

The docs assistant used to make you wait for the whole answer. Now the words appear as the model writes them, and the links to the pages it used arrive first, so you can start reading the source before the summary is done.

## How it works

The endpoint still answers with a single JSON object by default. When the browser asks for `text/event-stream`, it switches to Server-Sent Events: one `sources` event, then `delta` events with text, then `done`.

```bash
curl -N http://127.0.0.1:3000/__docubase/ask \
  -H "Content-Type: application/json" -H "Accept: text/event-stream" \
  -d '{"question":"How do I deploy?"}'
```

Nothing is written until the first piece of text arrives. If the model fails straight away you get an ordinary error, not a stream that stops in the middle.

## Closing the dialog stops the bill

When a reader closes the dialog, the request to your model provider is cancelled too. You pay for the tokens someone actually reads, with your own key, and Docubase never sees them.

:::note
Streaming works with Anthropic and any OpenAI compatible server, including a local Ollama.
:::
