import { loadModels } from "@deploybug/checker";
import { factsFromRequest, summarizeTicket } from "@deploybug/summarizer";
const f = factsFromRequest({ app: "stripe", tool: "STRIPE_CREATE_REFUND", agent: "support-agent", args: { charge: "ch_demo42", customer: "cus_demo1", amount: 1500 } }, "refund £15.00 needs owner approval", "local01");
console.log(JSON.stringify(await summarizeTicket(loadModels(), f), null, 1));
