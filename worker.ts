import { ExecutionContext } from "@cloudflare/workers-types";

export interface Env {
    REVENUECAT_WEBHOOK_AUTH_TOKEN: string;
    SUPABASE_KEY: string;
    SUPABASE_URL: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleWebhook(request, env);
  }
};

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  console.log("[handleWebhook] Starting webhook processing");
  console.log("[handleWebhook] env keys:", Object.keys(env));
  console.log("[handleWebhook] REVENUECAT_WEBHOOK_AUTH_TOKEN exists:", !!env.REVENUECAT_WEBHOOK_AUTH_TOKEN);
  console.log("[handleWebhook] SUPABASE_KEY exists:", !!env.SUPABASE_KEY);
  console.log("[handleWebhook] SUPABASE_URL exists:", !!env.SUPABASE_URL);

  const authHeader = request.headers.get('Authorization');
  console.log("[handleWebhook] Auth header received:", authHeader);

  if (!env.REVENUECAT_WEBHOOK_AUTH_TOKEN) {
    console.error("[handleWebhook] REVENUECAT_WEBHOOK_AUTH_TOKEN no está definido");
    return new Response('Error de configuración del servidor', { status: 500 });
  }

  const expectedToken = env.REVENUECAT_WEBHOOK_AUTH_TOKEN;
  console.log("[handleWebhook] Received token:", authHeader);

  if (authHeader !== `${expectedToken}`) {
    console.error("[handleWebhook] Token de autenticación inválido");
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const event = await request.json();
    console.log('[handleWebhook] Event received:', JSON.stringify(event));

    switch (event.event.type) {
      case 'INITIAL_PURCHASE':
      case 'RENEWAL':
      case 'PRODUCT_CHANGE':
      case 'NON_RENEWING_PURCHASE':
        console.log(`[handleWebhook] Processing purchase event: ${event.event.type}`);
        await handlePurchaseEvent(event, env);
        break;
      case 'CANCELLATION':
      case 'EXPIRATION':
        console.log(`[handleWebhook] Received cancellation or expiration: ${event.event.type}`);
        // Aquí puedes agregar lógica adicional para manejar cancelaciones o expiraciones si es necesario
        break;
      default:
        console.log(`[handleWebhook] Unhandled event type: ${event.event.type}`);
    }

    console.log('[handleWebhook] Webhook processing completed successfully');
    return new Response('OK', { status: 200 });
  } catch (error) {
    console.error('[handleWebhook] Error processing webhook:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

function getProductDetails(productId: string): { coinAmount: number, numberOfModels: number } {
  console.log(`[getProductDetails] Obteniendo detalles para el producto: ${productId}`);
  const productDetails: { [key: string]: { coinAmount: number, numberOfModels: number } } = {
    'subscribe.photos_ai_studio.1week_starter': { coinAmount: 50, numberOfModels: 1 },
    'subscribe.photos_ai_studio.1week_pro': { coinAmount: 100, numberOfModels: 2 },
    'subscribe.photos_ai_studio.1week_premium': { coinAmount: 250, numberOfModels: 3 }
  };
  return productDetails[productId] || { coinAmount: 0, numberOfModels: 0 };
}

async function handlePurchaseEvent(event: any, env: Env): Promise<void> {
  console.log('[handlePurchaseEvent] Iniciando procesamiento del evento de compra');
  const userId = event.event.app_user_id;
  const productId = event.event.product_id;
  const transactionId = event.event.id;
  const expirationDate = new Date(event.event.expiration_at_ms).toISOString().split('T')[0]; // Convertir a YYYY-MM-DD

  if (!transactionId) {
    console.error('[handlePurchaseEvent] ID de transacción no válido');
    throw new Error('ID de transacción no válido');
  }

  console.log(`[handlePurchaseEvent] ID de usuario: ${userId}, ID de producto: ${productId}, ID de transacción: ${transactionId}, Fecha de expiración: ${expirationDate}`);

  const { coinAmount, numberOfModels } = getProductDetails(productId);
  console.log(`[handlePurchaseEvent] Cantidad de monedas: ${coinAmount}, Número de modelos: ${numberOfModels}`);

  await updateUserCredits(userId, transactionId, coinAmount, numberOfModels, productId, expirationDate, env);
}

async function updateUserCredits(
  userId: string, 
  transactionId: string, 
  coinAmount: number, 
  numberOfModels: number, 
  productId: string,
  expirationDate: string,
  env: Env
): Promise<void> {
  console.log(`[updateUserCredits] Actualizando créditos para User ID: ${userId}, Transaction ID: ${transactionId}, Monedas: ${coinAmount}, Modelos: ${numberOfModels}, Producto: ${productId}, Expiración: ${expirationDate}`);

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
        p_expiration_date: expirationDate
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[updateUserCredits] Error en la respuesta de Supabase: ${errorText}`);
      throw new Error(`Error al actualizar los créditos del usuario: ${errorText}`);
    }

    const result = await response.json();
    console.log('[updateUserCredits] Créditos actualizados con éxito:', result);
  } catch (error) {
    console.error('[updateUserCredits] Error al actualizar los créditos del usuario:', error);
    throw error;
  }
}