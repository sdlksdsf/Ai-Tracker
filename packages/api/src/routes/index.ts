import type { FastifyInstance } from 'fastify';
import { API_BASE_PATH } from '@platematch/shared';
import { healthRoutes } from './health.routes.js';
import { authRoutes } from './auth.routes.js';
import { userRoutes } from './user.routes.js';
import { scanRoutes } from './scan.routes.js';
import { pantryRoutes } from './pantry.routes.js';
import { recipeRoutes } from './recipe.routes.js';
import { mealPlanRoutes } from './mealplan.routes.js';
import { groceryRoutes } from './grocery.routes.js';
import { wasteRoutes } from './waste.routes.js';
import { achievementRoutes } from './achievement.routes.js';
import { notificationRoutes } from './notification.routes.js';
import { subscriptionRoutes } from './subscription.routes.js';
import { dashboardRoutes } from './dashboard.routes.js';

/**
 * Route tree (Section 4).
 *
 * Every business endpoint lives under `API_BASE_PATH` (`/api/v1`). Operational
 * endpoints stay at the root so orchestrators can probe them without knowing
 * the API version.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // --- Operational (unversioned) ------------------------------------------
  await app.register(healthRoutes);

  // --- Business API -------------------------------------------------------
  await app.register(
    async (v1) => {
      await v1.register(authRoutes, { prefix: '/auth' });
      await v1.register(userRoutes, { prefix: '/users' });
      await v1.register(scanRoutes, { prefix: '/scan' });
      await v1.register(pantryRoutes, { prefix: '/pantry' });
      await v1.register(recipeRoutes, { prefix: '/recipes' });
      await v1.register(mealPlanRoutes, { prefix: '/meal-plans' });
      await v1.register(groceryRoutes, { prefix: '/grocery-lists' });
      await v1.register(wasteRoutes, { prefix: '/waste' });
      await v1.register(achievementRoutes, { prefix: '/achievements' });
      await v1.register(notificationRoutes, { prefix: '/notifications' });
      await v1.register(subscriptionRoutes, { prefix: '/subscription' });
      await v1.register(dashboardRoutes, { prefix: '/dashboard' });
    },
    { prefix: API_BASE_PATH },
  );

  // --- API index ----------------------------------------------------------
  app.get(API_BASE_PATH, {
    schema: { tags: ['health'], summary: 'API index', security: [] },
  }, async () => ({
    name: 'PlateMatch API',
    base_path: API_BASE_PATH,
    docs: '/docs',
    openapi: `${API_BASE_PATH}/openapi.json`,
    resources: [
      `${API_BASE_PATH}/auth`,
      `${API_BASE_PATH}/users`,
      `${API_BASE_PATH}/scan`,
      `${API_BASE_PATH}/pantry`,
      `${API_BASE_PATH}/recipes`,
      `${API_BASE_PATH}/meal-plans`,
      `${API_BASE_PATH}/grocery-lists`,
      `${API_BASE_PATH}/waste`,
      `${API_BASE_PATH}/achievements`,
      `${API_BASE_PATH}/notifications`,
      `${API_BASE_PATH}/subscription`,
      `${API_BASE_PATH}/dashboard`,
    ],
  }));
}
