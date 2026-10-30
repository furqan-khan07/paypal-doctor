export async function POST(req: Request) {
  const event = await req.json();
  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    await markPaid(event.resource.supplementary_data.related_ids.order_id as string);
  }
  return new Response("ok");
}

async function markPaid(id: string) {
  console.log("paid", id);
}
