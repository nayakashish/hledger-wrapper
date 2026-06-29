# Why This App Is Built Just for Me

If you are reading this, you probably know me and you are curious about what this is, or maybe you are hoping I can set you up with something similar. This is my honest explanation of why I built this the way I did, why it works for me specifically, and why I have not tried to make it work for everyone.

---

## What This Actually Is

This is a mobile app I built myself to check my personal finances on my phone. It connects to accounting software I run on a computer at home, and it lets me see my balances, track my spending, and add new transactions while I am out.

The accounting software it is built around is called hledger. It is not an app you download from the App Store. It is a command-line tool — the kind of thing you use by typing commands into a terminal window. It stores all your financial data in a plain text file that lives on your computer, not in anyone's cloud. No company has access to your numbers. Nothing is shared with advertisers. The file is yours and it stays on your machine.

That is the part I care most about.

---

## Why I Chose This Over Normal Apps

There are plenty of good apps that handle personal finance for most people. The ones I considered before going this route include:

**Mint** (now discontinued, but worth mentioning) — connected directly to your bank and automatically categorized your spending. Convenient, but your financial data lived on someone else's servers and was used to serve you ads.

**YNAB (You Need a Budget)** — genuinely excellent app, well-designed, used by a lot of people who take budgeting seriously. It syncs with your bank, has a great mobile experience, and teaches you to think about money in a useful way. Costs around $100 a year. Your data is in their cloud.

**Actual Budget** — open source, can be self-hosted, has bank syncing in some configurations. Much closer in spirit to what I built. A reasonable choice for someone who wants control over their data without doing everything from scratch.

**Copilot** — well-designed iPhone app, automatic bank import, good categorization. Subscription-based, data in the cloud.

Any of these would serve most people well. The reason I did not use them is not that they are bad. It is that I wanted something specific: my data stays on hardware I own, I have complete control over the format it is stored in, and I can query it any way I want using tools I understand. That is a preference, not a criticism of the alternatives.

---

## The Part That Makes This Not for Everyone

Here is the honest part.

hledger, the software at the core of this, requires you to record every single transaction yourself. There is no automatic bank import in the way I use it. Every time I buy a coffee, I add it. Every paycheque, I record it. Every time money moves, I write it down.

Most people will not do this. That is not a character flaw — it is just a reasonable assessment of how much friction is acceptable in daily life. Automatic bank syncing exists precisely because manual entry is a lot to ask of someone. I happen to find the manual process useful. It keeps me aware of where my money is going in a way that automatic categorization does not, because automatic categorization lets you look away.

But if you are not the kind of person who is going to open an app and log a $4 purchase every time it happens, this system will not work for you. It does not degrade gracefully. An incomplete ledger is not a useful ledger.

---

## Why I Did Not Build It for Multiple People

I thought about this. The short answer is that the tool itself is the bottleneck, not the app I built around it.

If I gave you access to this and you wanted to track your own finances, you would need to learn hledger, set up your own journal file, maintain it consistently, and be comfortable with the fact that nothing is automatic. For most people I know, that is too much to ask — not because they are not capable, but because the payoff does not justify the setup for someone who is not already bought into this way of thinking about money.

The app I built is a good solution to my specific problem. For your specific problem, one of the apps listed above is probably a better fit. YNAB in particular is worth a look if you want to take budgeting seriously without building your own tools.

---

## The Short Version

I built this because I wanted complete ownership of my financial data and I was willing to do the work that comes with that. The app is a layer on top of a tool that rewards discipline and punishes inconsistency. It suits me. For most people, a purpose-built app with automatic bank syncing and a polished interface will serve them better, and there is no shame in that.