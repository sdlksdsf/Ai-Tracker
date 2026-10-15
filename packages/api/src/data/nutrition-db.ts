import { normalizeIngredient } from '../utils/food.js';

/**
 * Offline food composition table (per 100 g edible portion)
 * ===========================================================================
 * Values are rounded from USDA FoodData Central / McCance & Widdowson
 * averages. Used when Edamam credentials are absent, when Edamam is
 * rate-limited, and as an instant first-pass estimate while the verified
 * Edamam figure is fetched asynchronously.
 *
 * Lookup is by longest-prefix match on the normalised ingredient key, so
 * "cherry tomato" and "canned tomato" both resolve to `tomato`.
 */

export interface FoodComposition {
  /** kcal per 100 g */
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  sugar: number;
  sodiumMg: number;
  /** mg per 100 g */
  potassiumMg?: number;
  cholesterolMg?: number;
  saturatedFat?: number;
  /** % DV per 100 g */
  vitaminAPct?: number;
  vitaminCPct?: number;
  calciumPct?: number;
  ironPct?: number;
}

const DB: Array<[keys: string[], values: FoodComposition]> = [
  [['chicken breast'], { kcal: 165, protein: 31, carbs: 0, fat: 3.6, fiber: 0, sugar: 0, sodiumMg: 74, potassiumMg: 256, cholesterolMg: 85, saturatedFat: 1, ironPct: 5, vitaminAPct: 1 }],
  [['chicken thigh'], { kcal: 209, protein: 26, carbs: 0, fat: 10.9, fiber: 0, sugar: 0, sodiumMg: 86, cholesterolMg: 93, saturatedFat: 3, ironPct: 7 }],
  [['chicken', 'poultry'], { kcal: 190, protein: 29, carbs: 0, fat: 7.5, fiber: 0, sugar: 0, sodiumMg: 80, cholesterolMg: 90, saturatedFat: 2, ironPct: 6 }],
  [['ground beef', 'beef mince'], { kcal: 250, protein: 26, carbs: 0, fat: 15, fiber: 0, sugar: 0, sodiumMg: 66, cholesterolMg: 78, saturatedFat: 6, ironPct: 15 }],
  [['beef', 'steak'], { kcal: 271, protein: 25, carbs: 0, fat: 19, fiber: 0, sugar: 0, sodiumMg: 72, cholesterolMg: 90, saturatedFat: 8, ironPct: 14 }],
  [['lamb', 'mutton'], { kcal: 294, protein: 25, carbs: 0, fat: 21, fiber: 0, sugar: 0, sodiumMg: 72, cholesterolMg: 97, saturatedFat: 9, ironPct: 10 }],
  [['pork'], { kcal: 242, protein: 27, carbs: 0, fat: 14, fiber: 0, sugar: 0, sodiumMg: 62, cholesterolMg: 80, saturatedFat: 5, ironPct: 5 }],
  [['bacon'], { kcal: 541, protein: 37, carbs: 1.4, fat: 42, fiber: 0, sugar: 0, sodiumMg: 1717, cholesterolMg: 110, saturatedFat: 14 }],
  [['sausage'], { kcal: 301, protein: 12, carbs: 2.7, fat: 27, fiber: 0, sugar: 1, sodiumMg: 749, cholesterolMg: 70, saturatedFat: 10 }],
  [['turkey'], { kcal: 189, protein: 29, carbs: 0, fat: 7.4, fiber: 0, sugar: 0, sodiumMg: 67, cholesterolMg: 76, saturatedFat: 2 }],
  [['salmon'], { kcal: 208, protein: 20, carbs: 0, fat: 13, fiber: 0, sugar: 0, sodiumMg: 59, potassiumMg: 363, cholesterolMg: 55, saturatedFat: 3, vitaminAPct: 2 }],
  [['tuna'], { kcal: 132, protein: 28, carbs: 0, fat: 1.3, fiber: 0, sugar: 0, sodiumMg: 47, potassiumMg: 237, cholesterolMg: 45 }],
  [['cod', 'white fish', 'fish'], { kcal: 82, protein: 18, carbs: 0, fat: 0.7, fiber: 0, sugar: 0, sodiumMg: 54, potassiumMg: 244, cholesterolMg: 43 }],
  [['shrimp', 'prawn'], { kcal: 99, protein: 24, carbs: 0.2, fat: 0.3, fiber: 0, sugar: 0, sodiumMg: 111, cholesterolMg: 189, potassiumMg: 259 }],
  [['egg'], { kcal: 155, protein: 13, carbs: 1.1, fat: 11, fiber: 0, sugar: 1.1, sodiumMg: 124, cholesterolMg: 373, saturatedFat: 3.3, vitaminAPct: 11, ironPct: 10, calciumPct: 5 }],
  [['paneer'], { kcal: 296, protein: 18, carbs: 3.4, fat: 23, fiber: 0, sugar: 3, sodiumMg: 30, saturatedFat: 14, calciumPct: 48 }],
  [['tofu', 'firm tofu'], { kcal: 144, protein: 17, carbs: 2.8, fat: 8.7, fiber: 2.3, sugar: 0.5, sodiumMg: 14, calciumPct: 53, ironPct: 15, potassiumMg: 237 }],
  [['whole milk', 'full fat milk', 'milk'], { kcal: 61, protein: 3.2, carbs: 4.8, fat: 3.3, fiber: 0, sugar: 4.8, sodiumMg: 43, calciumPct: 11, vitaminAPct: 3, cholesterolMg: 11 }],
  [['skim milk', 'low fat milk'], { kcal: 34, protein: 3.4, carbs: 5, fat: 0.1, fiber: 0, sugar: 5, sodiumMg: 42, calciumPct: 12 }],
  [['greek yogurt', 'yogurt', 'yoghurt', 'curd'], { kcal: 59, protein: 10, carbs: 3.6, fat: 0.4, fiber: 0, sugar: 3.2, sodiumMg: 36, calciumPct: 11, potassiumMg: 141 }],
  [['butter'], { kcal: 717, protein: 0.9, carbs: 0.1, fat: 81, fiber: 0, sugar: 0.1, sodiumMg: 11, saturatedFat: 51, vitaminAPct: 49, cholesterolMg: 215 }],
  [['ghee'], { kcal: 900, protein: 0, carbs: 0, fat: 100, fiber: 0, sugar: 0, sodiumMg: 2, saturatedFat: 62 }],
  [['cream', 'heavy cream'], { kcal: 340, protein: 2.8, carbs: 2.8, fat: 36, fiber: 0, sugar: 2.9, sodiumMg: 32, saturatedFat: 22, cholesterolMg: 137 }],
  [['cheddar cheese', 'cheese'], { kcal: 403, protein: 25, carbs: 1.3, fat: 33, fiber: 0, sugar: 0.5, sodiumMg: 621, calciumPct: 72, saturatedFat: 21, cholesterolMg: 105 }],
  [['mozzarella'], { kcal: 280, protein: 28, carbs: 3.1, fat: 17, fiber: 0, sugar: 1, sodiumMg: 628, calciumPct: 63 }],
  [['feta cheese', 'feta'], { kcal: 264, protein: 14, carbs: 4.1, fat: 21, fiber: 0, sugar: 4.1, sodiumMg: 917, calciumPct: 49 }],
  [['parmesan cheese', 'parmesan'], { kcal: 431, protein: 38, carbs: 4.1, fat: 29, fiber: 0, sugar: 0.8, sodiumMg: 1602, calciumPct: 118 }],
  [['coconut milk'], { kcal: 197, protein: 2, carbs: 3, fat: 21, fiber: 0.9, sugar: 2.8, sodiumMg: 15, saturatedFat: 19 }],
  [['basmati rice', 'white rice', 'rice'], { kcal: 130, protein: 2.7, carbs: 28, fat: 0.3, fiber: 0.4, sugar: 0, sodiumMg: 1, potassiumMg: 35 }],
  [['brown rice'], { kcal: 123, protein: 2.7, carbs: 26, fat: 1, fiber: 1.8, sugar: 0.4, sodiumMg: 4 }],
  [['spaghetti', 'pasta', 'linguine', 'penne', 'macaroni', 'noodle'], { kcal: 158, protein: 5.8, carbs: 31, fat: 0.9, fiber: 1.8, sugar: 0.6, sodiumMg: 1, ironPct: 7 }],
  [['rolled oats', 'oats', 'oatmeal'], { kcal: 389, protein: 16.9, carbs: 66, fat: 6.9, fiber: 10.6, sugar: 0, sodiumMg: 2, ironPct: 26, calciumPct: 5 }],
  [['quinoa'], { kcal: 120, protein: 4.4, carbs: 21, fat: 1.9, fiber: 2.8, sugar: 0.9, sodiumMg: 7, ironPct: 8 }],
  [['whole wheat flour', 'flour', 'wheat flour'], { kcal: 364, protein: 10, carbs: 76, fat: 1, fiber: 2.7, sugar: 0.3, sodiumMg: 2 }],
  [['bread', 'wholemeal bread', 'naan bread', 'pita'], { kcal: 265, protein: 9, carbs: 49, fat: 3.2, fiber: 2.7, sugar: 5, sodiumMg: 491, ironPct: 15 }],
  [['tortilla'], { kcal: 312, protein: 8, carbs: 52, fat: 8, fiber: 3.5, sugar: 1.5, sodiumMg: 445 }],
  [['potato'], { kcal: 77, protein: 2, carbs: 17, fat: 0.1, fiber: 2.2, sugar: 0.8, sodiumMg: 6, potassiumMg: 421, vitaminCPct: 33 }],
  [['sweet potato'], { kcal: 86, protein: 1.6, carbs: 20, fat: 0.1, fiber: 3, sugar: 4.2, sodiumMg: 55, potassiumMg: 337, vitaminAPct: 284, vitaminCPct: 3 }],
  [['tomato'], { kcal: 18, protein: 0.9, carbs: 3.9, fat: 0.2, fiber: 1.2, sugar: 2.6, sodiumMg: 5, potassiumMg: 237, vitaminCPct: 23, vitaminAPct: 17 }],
  [['cherry tomato'], { kcal: 18, protein: 0.9, carbs: 3.9, fat: 0.2, fiber: 1.2, sugar: 2.6, sodiumMg: 5, vitaminCPct: 23 }],
  [['canned tomato', 'tomato paste'], { kcal: 32, protein: 1.6, carbs: 7, fat: 0.2, fiber: 1.9, sugar: 4.5, sodiumMg: 132, vitaminCPct: 15 }],
  [['onion', 'red onion'], { kcal: 40, protein: 1.1, carbs: 9.3, fat: 0.1, fiber: 1.7, sugar: 4.2, sodiumMg: 4, vitaminCPct: 12 }],
  [['garlic'], { kcal: 149, protein: 6.4, carbs: 33, fat: 0.5, fiber: 2.1, sugar: 1, sodiumMg: 17, vitaminCPct: 52, ironPct: 9 }],
  [['ginger'], { kcal: 80, protein: 1.8, carbs: 18, fat: 0.8, fiber: 2, sugar: 1.7, sodiumMg: 13, vitaminCPct: 8 }],
  [['carrot'], { kcal: 41, protein: 0.9, carbs: 10, fat: 0.2, fiber: 2.8, sugar: 4.7, sodiumMg: 69, vitaminAPct: 334, vitaminCPct: 10 }],
  [['spinach'], { kcal: 23, protein: 2.9, carbs: 3.6, fat: 0.4, fiber: 2.2, sugar: 0.4, sodiumMg: 79, ironPct: 15, calciumPct: 10, vitaminAPct: 188, vitaminCPct: 47, potassiumMg: 558 }],
  [['lettuce'], { kcal: 15, protein: 1.4, carbs: 2.9, fat: 0.2, fiber: 1.3, sugar: 0.8, sodiumMg: 28, vitaminAPct: 148 }],
  [['cabbage'], { kcal: 25, protein: 1.3, carbs: 6, fat: 0.1, fiber: 2.5, sugar: 3.2, sodiumMg: 18, vitaminCPct: 61 }],
  [['broccoli'], { kcal: 34, protein: 2.8, carbs: 7, fat: 0.4, fiber: 2.6, sugar: 1.7, sodiumMg: 33, vitaminCPct: 149, vitaminAPct: 12, calciumPct: 5 }],
  [['cauliflower'], { kcal: 25, protein: 1.9, carbs: 5, fat: 0.3, fiber: 2, sugar: 1.9, sodiumMg: 30, vitaminCPct: 80 }],
  [['bell pepper', 'capsicum', 'pepper'], { kcal: 31, protein: 1, carbs: 6, fat: 0.3, fiber: 2.1, sugar: 4.2, sodiumMg: 4, vitaminCPct: 213, vitaminAPct: 19 }],
  [['green chili', 'chili', 'chilli'], { kcal: 40, protein: 1.9, carbs: 9.5, fat: 0.2, fiber: 1.5, sugar: 5.1, sodiumMg: 9, vitaminCPct: 242 }],
  [['cucumber'], { kcal: 15, protein: 0.7, carbs: 3.6, fat: 0.1, fiber: 0.5, sugar: 1.7, sodiumMg: 2, vitaminCPct: 15 }],
  [['zucchini', 'courgette'], { kcal: 17, protein: 1.2, carbs: 3.1, fat: 0.3, fiber: 1, sugar: 2.5, sodiumMg: 8, vitaminCPct: 29 }],
  [['mushroom'], { kcal: 22, protein: 3.1, carbs: 3.3, fat: 0.3, fiber: 1, sugar: 2, sodiumMg: 5, potassiumMg: 318, vitaminAPct: 0 }],
  [['celery'], { kcal: 16, protein: 0.7, carbs: 3, fat: 0.2, fiber: 1.6, sugar: 1.3, sodiumMg: 80, vitaminCPct: 5 }],
  [['green bean', 'bean'], { kcal: 31, protein: 1.8, carbs: 7, fat: 0.2, fiber: 2.7, sugar: 3.3, sodiumMg: 6, vitaminCPct: 20 }],
  [['green peas', 'peas'], { kcal: 81, protein: 5.4, carbs: 14, fat: 0.4, fiber: 5.1, sugar: 5.7, sodiumMg: 5, vitaminCPct: 67 }],
  [['corn', 'sweetcorn'], { kcal: 86, protein: 3.3, carbs: 19, fat: 1.4, fiber: 2, sugar: 6.3, sodiumMg: 15 }],
  [['eggplant', 'aubergine'], { kcal: 25, protein: 1, carbs: 6, fat: 0.2, fiber: 3, sugar: 3.5, sodiumMg: 2 }],
  [['spring onion', 'scallion'], { kcal: 32, protein: 1.8, carbs: 7.3, fat: 0.2, fiber: 2.6, sugar: 2.3, sodiumMg: 16, vitaminCPct: 31 }],
  [['coriander', 'cilantro'], { kcal: 23, protein: 2.1, carbs: 3.7, fat: 0.5, fiber: 2.8, sugar: 0.9, sodiumMg: 46, vitaminCPct: 45, vitaminAPct: 135 }],
  [['fresh basil', 'basil'], { kcal: 23, protein: 3.2, carbs: 2.7, fat: 0.6, fiber: 1.6, sugar: 0.3, sodiumMg: 4, vitaminAPct: 105 }],
  [['fresh parsley', 'parsley'], { kcal: 36, protein: 3, carbs: 6.3, fat: 0.8, fiber: 3.3, sugar: 0.9, sodiumMg: 56, vitaminCPct: 220, vitaminAPct: 168 }],
  [['fresh dill', 'dill'], { kcal: 43, protein: 3.5, carbs: 7, fat: 1.1, fiber: 2.1, sugar: 0, sodiumMg: 61, vitaminCPct: 142 }],
  [['apple'], { kcal: 52, protein: 0.3, carbs: 14, fat: 0.2, fiber: 2.4, sugar: 10, sodiumMg: 1, vitaminCPct: 8 }],
  [['banana'], { kcal: 89, protein: 1.1, carbs: 23, fat: 0.3, fiber: 2.6, sugar: 12, sodiumMg: 1, potassiumMg: 358, vitaminCPct: 15 }],
  [['orange'], { kcal: 47, protein: 0.9, carbs: 12, fat: 0.1, fiber: 2.4, sugar: 9, sodiumMg: 0, vitaminCPct: 89 }],
  [['lemon'], { kcal: 29, protein: 1.1, carbs: 9.3, fat: 0.3, fiber: 2.8, sugar: 2.5, sodiumMg: 2, vitaminCPct: 88 }],
  [['lime'], { kcal: 30, protein: 0.7, carbs: 11, fat: 0.2, fiber: 2.8, sugar: 1.7, sodiumMg: 2, vitaminCPct: 48 }],
  [['mango'], { kcal: 60, protein: 0.8, carbs: 15, fat: 0.4, fiber: 1.6, sugar: 14, sodiumMg: 1, vitaminCPct: 61, vitaminAPct: 22 }],
  [['strawberry', 'strawberries'], { kcal: 32, protein: 0.7, carbs: 7.7, fat: 0.3, fiber: 2, sugar: 4.9, sodiumMg: 1, vitaminCPct: 98 }],
  [['blueberry', 'blueberries'], { kcal: 57, protein: 0.7, carbs: 14, fat: 0.3, fiber: 2.4, sugar: 10, sodiumMg: 1, vitaminCPct: 16 }],
  [['avocado'], { kcal: 160, protein: 2, carbs: 8.5, fat: 15, fiber: 6.7, sugar: 0.7, sodiumMg: 7, potassiumMg: 485, vitaminCPct: 17, saturatedFat: 2.1 }],
  [['grape', 'grapes'], { kcal: 69, protein: 0.7, carbs: 18, fat: 0.2, fiber: 0.9, sugar: 16, sodiumMg: 2, vitaminCPct: 5 }],
  [['pineapple'], { kcal: 50, protein: 0.5, carbs: 13, fat: 0.1, fiber: 1.4, sugar: 9.9, sodiumMg: 1, vitaminCPct: 79 }],
  [['chickpea', 'chickpeas', 'garbanzo'], { kcal: 164, protein: 8.9, carbs: 27, fat: 2.6, fiber: 7.6, sugar: 4.8, sodiumMg: 7, ironPct: 16, potassiumMg: 291 }],
  [['black beans', 'black bean'], { kcal: 132, protein: 8.9, carbs: 24, fat: 0.5, fiber: 8.7, sugar: 0.3, sodiumMg: 2, ironPct: 12 }],
  [['kidney beans', 'kidney bean'], { kcal: 127, protein: 8.7, carbs: 23, fat: 0.5, fiber: 6.4, sugar: 0.3, sodiumMg: 2, ironPct: 16 }],
  [['white beans', 'white bean', 'cannellini'], { kcal: 139, protein: 9.7, carbs: 25, fat: 0.5, fiber: 6.3, sugar: 0.3, sodiumMg: 4, ironPct: 14 }],
  [['red lentils', 'lentil', 'lentils', 'dal'], { kcal: 116, protein: 9, carbs: 20, fat: 0.4, fiber: 7.9, sugar: 1.8, sodiumMg: 2, ironPct: 19 }],
  [['edamame', 'soybean'], { kcal: 121, protein: 11.9, carbs: 8.9, fat: 5.2, fiber: 5.2, sugar: 2.2, sodiumMg: 6, ironPct: 12 }],
  [['almond', 'almonds'], { kcal: 579, protein: 21, carbs: 22, fat: 50, fiber: 12.5, sugar: 4.4, sodiumMg: 1, calciumPct: 27, ironPct: 21, vitaminAPct: 0 }],
  [['peanut', 'peanuts'], { kcal: 567, protein: 26, carbs: 16, fat: 49, fiber: 8.5, sugar: 4.7, sodiumMg: 18 }],
  [['peanut butter'], { kcal: 588, protein: 25, carbs: 20, fat: 50, fiber: 6, sugar: 9, sodiumMg: 459, saturatedFat: 10 }],
  [['cashew', 'cashews'], { kcal: 553, protein: 18, carbs: 30, fat: 44, fiber: 3.3, sugar: 5.9, sodiumMg: 12, ironPct: 37 }],
  [['walnut', 'walnuts'], { kcal: 654, protein: 15, carbs: 14, fat: 65, fiber: 6.7, sugar: 2.6, sodiumMg: 2 }],
  [['chia seeds', 'chia'], { kcal: 486, protein: 17, carbs: 42, fat: 31, fiber: 34, sugar: 0, sodiumMg: 16, calciumPct: 63, ironPct: 43 }],
  [['olive oil'], { kcal: 884, protein: 0, carbs: 0, fat: 100, fiber: 0, sugar: 0, sodiumMg: 2, saturatedFat: 14 }],
  [['vegetable oil', 'canola oil', 'sunflower oil', 'oil'], { kcal: 884, protein: 0, carbs: 0, fat: 100, fiber: 0, sugar: 0, sodiumMg: 0, saturatedFat: 8 }],
  [['sesame oil'], { kcal: 884, protein: 0, carbs: 0, fat: 100, fiber: 0, sugar: 0, sodiumMg: 0, saturatedFat: 14 }],
  [['butter oil', 'coconut oil'], { kcal: 862, protein: 0, carbs: 0, fat: 100, fiber: 0, sugar: 0, sodiumMg: 0, saturatedFat: 87 }],
  [['sugar', 'brown sugar', 'white sugar'], { kcal: 387, protein: 0, carbs: 100, fat: 0, fiber: 0, sugar: 100, sodiumMg: 1 }],
  [['honey'], { kcal: 304, protein: 0.3, carbs: 82, fat: 0, fiber: 0.2, sugar: 82, sodiumMg: 4 }],
  [['maple syrup'], { kcal: 260, protein: 0, carbs: 67, fat: 0.1, fiber: 0, sugar: 60, sodiumMg: 12, calciumPct: 7 }],
  [['soy sauce'], { kcal: 53, protein: 8.1, carbs: 4.9, fat: 0.6, fiber: 0.8, sugar: 0.6, sodiumMg: 5637 }],
  [['ketchup'], { kcal: 101, protein: 1, carbs: 26, fat: 0.1, fiber: 0.3, sugar: 21, sodiumMg: 907 }],
  [['mustard', 'dijon mustard'], { kcal: 66, protein: 4.4, carbs: 5.3, fat: 4, fiber: 3.3, sugar: 2.2, sodiumMg: 1135 }],
  [['mayonnaise'], { kcal: 680, protein: 1, carbs: 0.6, fat: 75, fiber: 0, sugar: 0.6, sodiumMg: 635, saturatedFat: 12 }],
  [['tahini'], { kcal: 595, protein: 17, carbs: 21, fat: 54, fiber: 9.3, sugar: 0.5, sodiumMg: 115, calciumPct: 43, ironPct: 50 }],
  [['balsamic vinegar', 'vinegar'], { kcal: 88, protein: 0.5, carbs: 17, fat: 0, fiber: 0, sugar: 14, sodiumMg: 23 }],
  [['lemon juice'], { kcal: 22, protein: 0.4, carbs: 6.9, fat: 0.2, fiber: 0.3, sugar: 2.5, sodiumMg: 1, vitaminCPct: 65 }],
  [['vegetable stock', 'chicken stock', 'stock', 'broth'], { kcal: 15, protein: 1, carbs: 2, fat: 0.5, fiber: 0, sugar: 1, sodiumMg: 372 }],
  [['salt'], { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodiumMg: 38758 }],
  [['black pepper', 'pepper'], { kcal: 251, protein: 10, carbs: 64, fat: 3.3, fiber: 25, sugar: 0.6, sodiumMg: 20, ironPct: 54 }],
  [['cumin', 'ground cumin', 'cumin seeds'], { kcal: 375, protein: 18, carbs: 44, fat: 22, fiber: 11, sugar: 2.3, sodiumMg: 168, ironPct: 368 }],
  [['turmeric', 'ground turmeric'], { kcal: 312, protein: 9.7, carbs: 67, fat: 3.3, fiber: 23, sugar: 3.2, sodiumMg: 38, ironPct: 228 }],
  [['garam masala'], { kcal: 340, protein: 12, carbs: 55, fat: 9, fiber: 20, sugar: 3, sodiumMg: 60, ironPct: 100 }],
  [['chili powder', 'red chili powder'], { kcal: 282, protein: 13, carbs: 50, fat: 14, fiber: 35, sugar: 7, sodiumMg: 30, vitaminAPct: 245 }],
  [['smoked paprika', 'paprika'], { kcal: 282, protein: 14, carbs: 54, fat: 13, fiber: 35, sugar: 10, sodiumMg: 68, vitaminAPct: 246 }],
  [['ground cinnamon', 'cinnamon'], { kcal: 247, protein: 4, carbs: 81, fat: 1.2, fiber: 53, sugar: 2.2, sodiumMg: 10, calciumPct: 100, ironPct: 46 }],
  [['oregano', 'dried oregano'], { kcal: 265, protein: 9, carbs: 69, fat: 4.3, fiber: 43, sugar: 4, sodiumMg: 25, vitaminAPct: 34 }],
  [['cornstarch', 'cornflour'], { kcal: 381, protein: 0.3, carbs: 91, fat: 0.1, fiber: 0.9, sugar: 0, sodiumMg: 9 }],
  [['kalamata olives', 'olives', 'olive'], { kcal: 115, protein: 0.8, carbs: 6.3, fat: 10.7, fiber: 3.2, sugar: 0, sodiumMg: 735 }],
  [['amchur powder'], { kcal: 300, protein: 3, carbs: 70, fat: 1, fiber: 15, sugar: 5, sodiumMg: 20 }],
  [['water'], { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodiumMg: 0 }],
];

interface CompiledEntry {
  keys: string[];
  values: FoodComposition;
  /** Longest key — used to prefer the most specific match. */
  specificity: number;
}

let compiled: CompiledEntry[] | null = null;

function compile(): CompiledEntry[] {
  if (compiled) return compiled;
  compiled = DB.map(([keys, values]) => {
    const normalized = keys.map(normalizeIngredient).filter(Boolean).sort((a, b) => b.length - a.length);
    return { keys: normalized, values, specificity: normalized[0]?.length ?? 0 };
  }).sort((a, b) => b.specificity - a.specificity);
  return compiled;
}

/** Look up a food's composition per 100 g. Returns null when unknown. */
export function lookupComposition(name: string): FoodComposition | null {
  const key = normalizeIngredient(name);
  if (!key) return null;

  const entries = compile();

  // Exact key match wins.
  for (const entry of entries) {
    if (entry.keys.includes(key)) return entry.values;
  }
  // Then substring (longest key first, thanks to the specificity sort).
  for (const entry of entries) {
    for (const k of entry.keys) {
      if (key.includes(k) || k.includes(key)) return entry.values;
    }
  }
  return null;
}

/** Scale a per-100 g composition to a gram amount. */
export function scaleComposition(comp: FoodComposition, grams: number): FoodComposition {
  const factor = grams / 100;
  const scale = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * factor * 10) / 10);
  return {
    kcal: Math.round(comp.kcal * factor),
    protein: scale(comp.protein) ?? 0,
    carbs: scale(comp.carbs) ?? 0,
    fat: scale(comp.fat) ?? 0,
    fiber: scale(comp.fiber) ?? 0,
    sugar: scale(comp.sugar) ?? 0,
    sodiumMg: Math.round(scale(comp.sodiumMg) ?? 0),
    potassiumMg: scale(comp.potassiumMg),
    cholesterolMg: scale(comp.cholesterolMg),
    saturatedFat: scale(comp.saturatedFat),
    vitaminAPct: scale(comp.vitaminAPct),
    vitaminCPct: scale(comp.vitaminCPct),
    calciumPct: scale(comp.calciumPct),
    ironPct: scale(comp.ironPct),
  };
}

export const NUTRITION_DB_SIZE = DB.length;
