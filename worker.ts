import { ExecutionContext } from "@cloudflare/workers-types";

export interface Env {
    REVENUECAT_WEBHOOK_AUTH_TOKEN: string;
    SUPABASE_KEY: string;
    SUPABASE_URL: string;
}

const PLAN_HIERARCHY = {
  'subscribe.photos_ai_studio.1month_basic': 1,
  'subscribe.photos_ai_studio.1month_starter': 2,
  'subscribe.photos_ai_studio.1month_pro': 3,
  'subscribe.photos_ai_studio.1month_premium': 4
} as const;

type PlanId = keyof typeof PLAN_HIERARCHY;

function isUpgrade(currentPlan: string, newPlan: string): boolean {
  return (PLAN_HIERARCHY[newPlan as PlanId] || 0) > (PLAN_HIERARCHY[currentPlan as PlanId] || 0);
}

const BASE_PRICES = {
  'subscribe.photos_ai_studio.1month_basic': 6.99,
  'subscribe.photos_ai_studio.1month_starter': 8.99,
  'subscribe.photos_ai_studio.1month_pro': 18.99,
  'subscribe.photos_ai_studio.1month_premium': 27.99
} as const;

function calculateAdjustedCredits(baseCredits: number, paidPrice: number, productId: string, isRenewal: boolean): number {
  console.log(`[calculateAdjustedCredits] Starting calculation for product: ${productId}`);
  console.log(`[calculateAdjustedCredits] Base credits: ${baseCredits}`);
  /*console.log(`[calculateAdjustedCredits] Paid price: ${paidPrice}`);
  console.log(`[calculateAdjustedCredits] Is renewal: ${isRenewal}`);
  
  // Si es una renovación, devolvemos los créditos base sin ajustar
  if (isRenewal) {
    console.log(`[calculateAdjustedCredits] Renewal detected - returning base credits: ${baseCredits}`);
    return baseCredits;
  }
  
  const basePrice = BASE_PRICES[productId as keyof typeof BASE_PRICES] || 0;
  console.log(`[calculateAdjustedCredits] Base price for product: ${basePrice}`);
  
  if (!basePrice) {
    console.log(`[calculateAdjustedCredits] No base price found, returning original credits: ${baseCredits}`);
    return baseCredits;
  }
  
  const priceRatio = paidPrice / basePrice;
  console.log(`[calculateAdjustedCredits] Price ratio: ${priceRatio}`);
  
  const result = Math.ceil(baseCredits * priceRatio);
  console.log(`[calculateAdjustedCredits] Final adjusted credits: ${result}`);
  return result;*/
  return baseCredits;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleWebhook(request, env);
  }
};

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  console.log("[handleWebhook] Starting webhook processing");

  const authHeader = request.headers.get('Authorization');
  if (!env.REVENUECAT_WEBHOOK_AUTH_TOKEN || authHeader !== `${env.REVENUECAT_WEBHOOK_AUTH_TOKEN}`) {
    console.error("[handleWebhook] Invalid authentication token");
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const event = await request.json();
    console.log('[handleWebhook] Event received:', JSON.stringify(event));

    switch (event.event.type) {
      case 'INITIAL_PURCHASE':
      case 'RENEWAL':
      case 'NON_RENEWING_PURCHASE':
        console.log(`[handleWebhook] Processing standard purchase event: ${event.event.type}`);
        await handlePurchaseEvent(event, env);
        break;
      case 'PRODUCT_CHANGE':
        console.log(`[handleWebhook] Processing product change event`);
        await handleProductChangeEvent(event, env);
        break;
      case 'CANCELLATION':
      case 'EXPIRATION':
        console.log(`[handleWebhook] Received cancellation or expiration: ${event.event.type}`);
        break;
      default:
        console.log(`[handleWebhook] Unhandled event type: ${event.event.type}`);
    }

    return new Response('OK', { status: 200 });
  } catch (error) {
    console.error('[handleWebhook] Error processing webhook:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

async function handleProductChangeEvent(event: any, env: Env): Promise<void> {
  const currentPlan = event.event.product_id;
  const newPlan = event.event.new_product_id;
  const userId = event.event.app_user_id;
  const transactionId = event.event.id;
  const expirationDate = new Date(event.event.expiration_at_ms).toISOString().split('T')[0];
  const paidPrice = event.event.price_in_purchased_currency || 0;
  const isSandbox = event.event.environment === 'SANDBOX';

  console.log(`[handleProductChangeEvent] Processing change:
    From: ${currentPlan}
    To: ${newPlan}
    User: ${userId}
    Paid Price: ${paidPrice}
    Expiration: ${expirationDate}`);

  // Si es downgrade, no procesamos el cambio
  if (!isUpgrade(currentPlan, newPlan)) {
    console.log('[handleProductChangeEvent] Downgrade detected - changes will apply on next renewal');
    return;
  }

  // Para upgrades en sandbox o con pago, procesamos el cambio
  if (paidPrice > 0 || isSandbox) {
    console.log('[handleProductChangeEvent] Processing upgrade');
    const { coinAmount, numberOfModels } = getProductDetails(newPlan);
    
    await updateUserCredits(
      userId,
      transactionId,
      coinAmount, // Enviamos los créditos base del nuevo plan
      numberOfModels,
      newPlan,
      expirationDate,
      false,
      false,
      env
    );
  } else {
    console.log('[handleProductChangeEvent] Skipping - no payment associated with upgrade');
  }
}

function getProductDetails(productId: string): { coinAmount: number, numberOfModels: number, isConsumable: boolean } {
  const productDetails: { [key: string]: { coinAmount: number, numberOfModels: number, isConsumable: boolean } } = {
    'subscribe.photos_ai_studio.1month_basic': { coinAmount: 20, numberOfModels: 1, isConsumable: false },
    'subscribe.photos_ai_studio.1month_starter': { coinAmount: 50, numberOfModels: 1, isConsumable: false },
    'subscribe.photos_ai_studio.1month_pro': { coinAmount: 200, numberOfModels: 1, isConsumable: false },
    'subscribe.photos_ai_studio.1month_premium': { coinAmount: 300, numberOfModels: 2, isConsumable: false },
    'photosai.credits.100': { coinAmount: 100, numberOfModels: 0, isConsumable: true }
  };
  return productDetails[productId] || { coinAmount: 0, numberOfModels: 0, isConsumable: false };
}

async function handlePurchaseEvent(event: any, env: Env): Promise<void> {
  const userId = event.event.app_user_id;
  const transactionId = event.event.id;
  const isRenewal = event.event.type === 'RENEWAL';
  const paidPrice = event.event.price_in_purchased_currency || 0;

  const effectiveProductId = event.event.new_product_id || event.event.product_id;
  const expirationDate = new Date(event.event.expiration_at_ms).toISOString().split('T')[0];

  console.log(`[handlePurchaseEvent] Processing purchase for product: ${effectiveProductId}`);

  const { coinAmount, numberOfModels, isConsumable } = getProductDetails(effectiveProductId);
  const adjustedCoins = isConsumable ? coinAmount : calculateAdjustedCredits(coinAmount, paidPrice, effectiveProductId, isRenewal);
  
  await updateUserCredits(
    userId,
    transactionId,
    adjustedCoins,
    numberOfModels,
    effectiveProductId,
    expirationDate,
    isConsumable,
    isRenewal,
    env
  );
}

async function updateUserCredits(
  userId: string, 
  transactionId: string, 
  coinAmount: number, 
  numberOfModels: number, 
  productId: string,
  expirationDate: string,
  isConsumable: boolean,
  isRenewal: boolean,
  env: Env
): Promise<void> {
  console.log(`[updateUserCredits] Processing update:
    User: ${userId}
    Transaction: ${transactionId}
    Coins: ${coinAmount}
    Models: ${numberOfModels}
    Product: ${productId}
    Is Renewal: ${isRenewal}
    Is Consumable: ${isConsumable}`);

  if (!isValidUUID(userId)) {
    console.error('[updateUserCredits] Invalid UUID:', userId);
    throw new Error('User ID is not a valid UUID');
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
    
    console.log('[updateUserCredits] Sending request to Supabase:', JSON.stringify(requestBody, null, 2));

    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/process_transaction`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': env.SUPABASE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_KEY}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[updateUserCredits] Supabase error response:', errorText);
      throw new Error(`Error updating user credits: ${errorText}`);
    }

    const result = await response.json();
    console.log('[updateUserCredits] Success! Result:', JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('[updateUserCredits] Error details:', error);
    throw error;
  }
}

function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}