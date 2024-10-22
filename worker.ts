import { ExecutionContext } from "@cloudflare/workers-types";

export interface Env {
    REVENUECAT_WEBHOOK_AUTH_TOKEN: string;
    SUPABASE_KEY: string;
    SUPABASE_URL: string;
}

// Definir la jerarquía de planes
const PLAN_HIERARCHY = {
  'subscribe.photos_ai_studio.1week_starter': 1,
  'subscribe.photos_ai_studio.1week_pro': 2,
  'subscribe.photos_ai_studio.1week_premium': 3
} as const;

type PlanId = keyof typeof PLAN_HIERARCHY;

function isUpgrade(currentPlan: string, newPlan: string): boolean {
  return (PLAN_HIERARCHY[newPlan as PlanId] || 0) > (PLAN_HIERARCHY[currentPlan as PlanId] || 0);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleWebhook(request, env);
  }
};

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  console.log("[handleWebhook] Starting webhook processing");

  // Validación del token
  const authHeader = request.headers.get('Authorization');
  if (!env.REVENUECAT_WEBHOOK_AUTH_TOKEN || authHeader !== `${env.REVENUECAT_WEBHOOK_AUTH_TOKEN}`) {
    console.error("[handleWebhook] Token de autenticación inválido");
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
        // Aquí puedes agregar lógica para limpiar o actualizar cuando expire la suscripción
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
  const currentPlan = event.event.product_id; // Plan actual
  const newPlan = event.event.new_product_id; // Plan al que cambia
  const userId = event.event.app_user_id;
  const transactionId = event.event.id;
  const expirationDate = new Date(event.event.expiration_at_ms).toISOString().split('T')[0];

  console.log(`[handleProductChangeEvent] Change from ${currentPlan} to ${newPlan}`);

  // Verificar si es upgrade o downgrade
  if (isUpgrade(currentPlan, newPlan)) {
    console.log('[handleProductChangeEvent] Processing as upgrade - applying immediately');
    const { coinAmount, numberOfModels } = getProductDetails(newPlan);
    await updateUserCredits(
      userId,
      transactionId,
      coinAmount,
      numberOfModels,
      newPlan,
      expirationDate,
      false, // is_consumable
      false, // is_renewal
      env,
      true  // is_upgrade
    );
  } else {
    console.log('[handleProductChangeEvent] Processing as downgrade - scheduling for next period');
    const { coinAmount, numberOfModels } = getProductDetails(newPlan);
    await updateUserCredits(
      userId,
      transactionId,
      coinAmount,
      numberOfModels,
      newPlan,
      expirationDate,
      false, // is_consumable
      false, // is_renewal
      env,
      false  // is_upgrade
    );
  }
}

function getProductDetails(productId: string): { coinAmount: number, numberOfModels: number, isConsumable: boolean } {
  const productDetails: { [key: string]: { coinAmount: number, numberOfModels: number, isConsumable: boolean } } = {
    'subscribe.photos_ai_studio.1week_starter': { coinAmount: 50, numberOfModels: 1, isConsumable: false },
    'subscribe.photos_ai_studio.1week_pro': { coinAmount: 100, numberOfModels: 2, isConsumable: false },
    'subscribe.photos_ai_studio.1week_premium': { coinAmount: 250, numberOfModels: 3, isConsumable: false },
    'photosai.credits.100': { coinAmount: 100, numberOfModels: 0, isConsumable: true }
  };
  return productDetails[productId] || { coinAmount: 0, numberOfModels: 0, isConsumable: false };
}

async function handlePurchaseEvent(event: any, env: Env): Promise<void> {
  const userId = event.event.app_user_id;
  const transactionId = event.event.id;
  const isRenewal = event.event.type === 'RENEWAL';

  // Si es una renovación y hay un cambio de plan, usar el nuevo plan
  const effectiveProductId = event.event.new_product_id || event.event.product_id;
  const expirationDate = new Date(event.event.expiration_at_ms).toISOString().split('T')[0];

  console.log(`[handlePurchaseEvent] Processing purchase for product: ${effectiveProductId}`);

  const { coinAmount, numberOfModels, isConsumable } = getProductDetails(effectiveProductId);
  
  await updateUserCredits(
    userId,
    transactionId,
    coinAmount,
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
  if (!isValidUUID(userId)) {
    throw new Error('User ID no es un UUID válido');
  }

  try {
    const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/process_transaction`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': env.SUPABASE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_KEY}`
      },
      body: JSON.stringify({
        p_user_id: userId,
        p_transaction_id: transactionId,
        p_coin_amount: coinAmount,
        p_models: numberOfModels,
        p_product_id: productId,
        p_expiration_date: expirationDate,
        p_is_consumable: isConsumable,
        p_is_renewal: isRenewal
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Error al actualizar los créditos del usuario: ${errorText}`);
    }

    const result = await response.json();
    console.log('[updateUserCredits] Créditos actualizados con éxito:', result);
  } catch (error) {
    console.error('[updateUserCredits] Error:', error);
    throw error;
  }
}

function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}