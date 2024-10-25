// worker.ts
var PLAN_HIERARCHY = {
  "subscribe.photos_ai_studio.1week_basic": 1,
  "subscribe.photos_ai_studio.1week_starter": 2,
  "subscribe.photos_ai_studio.1week_pro": 3,
  "subscribe.photos_ai_studio.1week_premium": 4
};
function isUpgrade(currentPlan, newPlan) {
  return (PLAN_HIERARCHY[newPlan] || 0) > (PLAN_HIERARCHY[currentPlan] || 0);
}
var BASE_PRICES = {
  "subscribe.photos_ai_studio.1week_basic": 6.99,
  "subscribe.photos_ai_studio.1week_starter": 9.99,
  "subscribe.photos_ai_studio.1week_pro": 17.99,
  "subscribe.photos_ai_studio.1week_premium": 24.99
};
function calculateAdjustedCredits(baseCredits, paidPrice, productId) {
  console.log(`[calculateAdjustedCredits] Starting calculation for product: ${productId}`);
  console.log(`[calculateAdjustedCredits] Base credits: ${baseCredits}`);
  console.log(`[calculateAdjustedCredits] Paid price: ${paidPrice}`);
  const basePrice = BASE_PRICES[productId] || 0;
  console.log(`[calculateAdjustedCredits] Base price for product: ${basePrice}`);
  if (!basePrice) {
    console.log(`[calculateAdjustedCredits] No base price found, returning original credits: ${baseCredits}`);
    return baseCredits;
  }
  const priceRatio = paidPrice / basePrice;
  console.log(`[calculateAdjustedCredits] Price ratio: ${priceRatio}`);
  const result = Math.ceil(baseCredits * priceRatio);
  console.log(`[calculateAdjustedCredits] Final adjusted credits: ${result}`);
  return result;
}
var worker_default = {
  async fetch(request, env, ctx) {
    return handleWebhook(request, env);
  }
};
async function handleWebhook(request, env) {
  console.log("[handleWebhook] Starting webhook processing");
  const authHeader = request.headers.get("Authorization");
  if (!env.REVENUECAT_WEBHOOK_AUTH_TOKEN || authHeader !== `${env.REVENUECAT_WEBHOOK_AUTH_TOKEN}`) {
    console.error("[handleWebhook] Token de autenticaci\xF3n inv\xE1lido");
    return new Response("Unauthorized", { status: 401 });
  }
  try {
    const event = await request.json();
    console.log("[handleWebhook] Event received:", JSON.stringify(event));
    switch (event.event.type) {
      case "INITIAL_PURCHASE":
      case "RENEWAL":
      case "NON_RENEWING_PURCHASE":
        console.log(`[handleWebhook] Processing standard purchase event: ${event.event.type}`);
        await handlePurchaseEvent(event, env);
        break;
      case "PRODUCT_CHANGE":
        console.log(`[handleWebhook] Processing product change event`);
        await handleProductChangeEvent(event, env);
        break;
      case "CANCELLATION":
      case "EXPIRATION":
        console.log(`[handleWebhook] Received cancellation or expiration: ${event.event.type}`);
        break;
      default:
        console.log(`[handleWebhook] Unhandled event type: ${event.event.type}`);
    }
    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("[handleWebhook] Error processing webhook:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}
async function handleProductChangeEvent(event, env) {
  console.log("[handleProductChangeEvent] Full event data:", JSON.stringify(event.event, null, 2));
  if (event.event.expiration_at_ms < event.event.event_timestamp_ms) {
    console.log(`[handleProductChangeEvent] Skipping due to timing:
      expiration_at_ms: ${event.event.expiration_at_ms}
      event_timestamp_ms: ${event.event.event_timestamp_ms}
      difference: ${event.event.expiration_at_ms - event.event.event_timestamp_ms}ms`);
    return;
  }
  const currentPlan = event.event.product_id;
  const newPlan = event.event.new_product_id;
  const userId = event.event.app_user_id;
  const transactionId = event.event.id;
  const expirationDate = new Date(event.event.expiration_at_ms).toISOString().split("T")[0];
  const paidPrice = event.event.price_in_purchased_currency || 0;
  console.log(`[handleProductChangeEvent] Processing change:
    From: ${currentPlan}
    To: ${newPlan}
    User: ${userId}
    Paid Price: ${paidPrice}
    Expiration: ${expirationDate}`);
  if (isUpgrade(currentPlan, newPlan)) {
    console.log("[handleProductChangeEvent] Confirmed as upgrade");
    const { coinAmount, numberOfModels } = getProductDetails(newPlan);
    console.log(`[handleProductChangeEvent] Base plan details:
      Base Coins: ${coinAmount}
      Models: ${numberOfModels}`);
    const adjustedCoins = calculateAdjustedCredits(coinAmount, paidPrice, newPlan);
    console.log(`[handleProductChangeEvent] After adjustment:
      Original coins: ${coinAmount}
      Adjusted coins: ${adjustedCoins}
      Difference: ${adjustedCoins - coinAmount}`);
    await updateUserCredits(
      userId,
      transactionId,
      adjustedCoins,
      numberOfModels,
      newPlan,
      expirationDate,
      false,
      false,
      env,
      true
    );
  } else {
    console.log("[handleProductChangeEvent] Processing as downgrade");
    const { coinAmount, numberOfModels } = getProductDetails(newPlan);
    await updateUserCredits(
      userId,
      transactionId,
      coinAmount,
      numberOfModels,
      newPlan,
      expirationDate,
      false,
      false,
      env,
      false
    );
  }
}
function getProductDetails(productId) {
  const productDetails = {
    "subscribe.photos_ai_studio.1week_basic": { coinAmount: 20, numberOfModels: 1, isConsumable: false },
    "subscribe.photos_ai_studio.1week_starter": { coinAmount: 50, numberOfModels: 1, isConsumable: false },
    "subscribe.photos_ai_studio.1week_pro": { coinAmount: 100, numberOfModels: 2, isConsumable: false },
    "subscribe.photos_ai_studio.1week_premium": { coinAmount: 250, numberOfModels: 3, isConsumable: false },
    "photosai.credits.100": { coinAmount: 100, numberOfModels: 0, isConsumable: true }
  };
  return productDetails[productId] || { coinAmount: 0, numberOfModels: 0, isConsumable: false };
}
async function handlePurchaseEvent(event, env) {
  const userId = event.event.app_user_id;
  const transactionId = event.event.id;
  const isRenewal = event.event.type === "RENEWAL";
  const paidPrice = event.event.price_in_purchased_currency || 0;
  const effectiveProductId = event.event.new_product_id || event.event.product_id;
  const expirationDate = new Date(event.event.expiration_at_ms).toISOString().split("T")[0];
  console.log(`[handlePurchaseEvent] Processing purchase for product: ${effectiveProductId}`);
  const { coinAmount, numberOfModels, isConsumable } = getProductDetails(effectiveProductId);
  const adjustedCoins = isConsumable ? coinAmount : calculateAdjustedCredits(coinAmount, paidPrice, effectiveProductId);
  await updateUserCredits(
    userId,
    transactionId,
    adjustedCoins,
    numberOfModels,
    effectiveProductId,
    expirationDate,
    isConsumable,
    isRenewal,
    env,
    false
  );
}
async function updateUserCredits(userId, transactionId, coinAmount, numberOfModels, productId, expirationDate, isConsumable, isRenewal, env, isUpgrade2) {
  console.log(`[updateUserCredits] Processing update:
    User: ${userId}
    Transaction: ${transactionId}
    Coins: ${coinAmount}
    Models: ${numberOfModels}
    Product: ${productId}
    Is Upgrade: ${isUpgrade2}
    Is Renewal: ${isRenewal}
    Is Consumable: ${isConsumable}`);
  if (!isValidUUID(userId)) {
    console.error("[updateUserCredits] Invalid UUID:", userId);
    throw new Error("User ID no es un UUID v\xE1lido");
  }
  try {
    const requestBody = {
      p_user_id: userId,
      p_transaction_id: transactionId,
      p_coin_amount: coinAmount,
      p_models: numberOfModels,
      p_product_id: productId,
      p_expiration_date: expirationDate,
      p_is_consumable: isConsumable,
      p_is_renewal: isRenewal
    };
    console.log("[updateUserCredits] Sending request to Supabase:", JSON.stringify(requestBody, null, 2));
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/process_transaction`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": env.SUPABASE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_KEY}`
      },
      body: JSON.stringify(requestBody)
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("[updateUserCredits] Supabase error response:", errorText);
      throw new Error(`Error al actualizar los cr\xE9ditos del usuario: ${errorText}`);
    }
    const result = await response.json();
    console.log("[updateUserCredits] Success! Result:", JSON.stringify(result, null, 2));
  } catch (error) {
    console.error("[updateUserCredits] Error details:", error);
    throw error;
  }
}
function isValidUUID(uuid) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
