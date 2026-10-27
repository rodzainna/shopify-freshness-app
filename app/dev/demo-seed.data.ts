import type { DemoProduct } from "./demo-seed";

// The demo store's products and batches; days count from the seed day.
// Some stock differs from the batches on purpose, to show the Stock check column.
export const DEMO_PRODUCTS: readonly DemoProduct[] = [
  {
    handle: "sourdough-loaf",
    title: "Sourdough loaf",
    stock: null,
    batches: [
      [6, -4],
      [12, 1],
    ],
  },
  {
    handle: "whole-milk-1l",
    title: "Whole milk 1L",
    stock: 25,
    batches: [
      [10, -8],
      [20, 6],
    ],
  },
  {
    handle: "free-range-eggs-12",
    title: "Free-range eggs (12)",
    stock: null,
    batches: [[15, 19]],
  },
  {
    handle: "aged-cheddar",
    title: "Aged cheddar",
    stock: 10,
    batches: [[8, 125]],
  },
  {
    handle: "croissants-4-pack",
    title: "Croissants 4-pack",
    stock: 18,
    batches: [
      [8, -1],
      [10, 1],
    ],
  },
  { handle: "rye-bread", title: "Rye bread", stock: 14, batches: [[14, 5]] },
  {
    handle: "whole-wheat-bread",
    title: "Whole wheat bread",
    stock: 20,
    batches: [
      [8, 2],
      [12, 6],
    ],
  },
  {
    handle: "bagels-6-pack",
    title: "Bagels 6-pack",
    stock: 16,
    batches: [[16, 4]],
  },
  {
    handle: "pita-bread-6-pack",
    title: "Pita bread 6-pack",
    stock: 22,
    batches: [
      [10, 3],
      [12, 9],
    ],
  },
  {
    handle: "banana-bread",
    title: "Banana bread",
    stock: 10,
    batches: [[10, 0]],
  },
  {
    handle: "cinnamon-rolls-4-pack",
    title: "Cinnamon rolls 4-pack",
    stock: 12,
    batches: [[12, 1]],
  },
  {
    handle: "organic-eggs-6-pack",
    title: "Organic eggs 6-pack",
    stock: 24,
    batches: [
      [12, 14],
      [12, 24],
    ],
  },
  {
    handle: "skim-milk-1l",
    title: "Skim milk 1L",
    stock: 30,
    batches: [
      [10, -2],
      [20, 8],
    ],
  },
  {
    handle: "oat-milk-1l",
    title: "Oat milk 1L",
    stock: 26,
    batches: [[26, 45]],
  },
  {
    handle: "greek-yogurt-500g",
    title: "Greek yogurt 500g",
    stock: 20,
    batches: [
      [6, 2],
      [14, 16],
    ],
  },
  {
    handle: "salted-butter-250g",
    title: "Salted butter 250g",
    stock: 28,
    batches: [
      [12, 30],
      [16, 58],
    ],
  },
  {
    handle: "heavy-cream-300ml",
    title: "Heavy cream 300ml",
    stock: 15,
    batches: [[15, 6]],
  },
  {
    handle: "sour-cream-250g",
    title: "Sour cream 250g",
    stock: 14,
    batches: [[14, 12]],
  },
  {
    handle: "brie-200g",
    title: "Brie 200g",
    stock: 9,
    batches: [
      [6, 9],
      [6, 20],
    ],
  },
  {
    handle: "mozzarella-250g",
    title: "Mozzarella 250g",
    stock: 16,
    batches: [[16, 10]],
  },
  {
    handle: "cottage-cheese-500g",
    title: "Cottage cheese 500g",
    stock: 12,
    batches: [
      [5, -3],
      [7, 7],
    ],
  },
  {
    handle: "baby-spinach-200g",
    title: "Baby spinach 200g",
    stock: 10,
    batches: [[10, -1]],
  },
  {
    handle: "romaine-lettuce",
    title: "Romaine lettuce",
    stock: 18,
    batches: [[18, 5]],
  },
  {
    handle: "strawberries-250g",
    title: "Strawberries 250g",
    stock: 20,
    batches: [
      [8, 1],
      [12, 4],
    ],
  },
  {
    handle: "blueberries-125g",
    title: "Blueberries 125g",
    stock: 22,
    batches: [[22, 8]],
  },
  {
    handle: "bananas-bunch",
    title: "Bananas (bunch)",
    stock: 30,
    batches: [[30, 5]],
  },
  {
    handle: "apples-1kg",
    title: "Apples 1kg",
    stock: 25,
    batches: [
      [10, 14],
      [15, 30],
    ],
  },
  {
    handle: "lemons-4-pack",
    title: "Lemons 4-pack",
    stock: 20,
    batches: [[20, 21]],
  },
  {
    handle: "avocados-2-pack",
    title: "Avocados 2-pack",
    stock: 16,
    batches: [
      [6, 2],
      [10, 6],
    ],
  },
  {
    handle: "cherry-tomatoes-250g",
    title: "Cherry tomatoes 250g",
    stock: 24,
    batches: [[24, 7]],
  },
  {
    handle: "cucumbers-2-pack",
    title: "Cucumbers 2-pack",
    stock: 18,
    batches: [[18, 6]],
  },
  {
    handle: "carrots-1kg",
    title: "Carrots 1kg",
    stock: 26,
    batches: [[26, 18]],
  },
  { handle: "broccoli", title: "Broccoli", stock: 15, batches: [[15, 3]] },
  {
    handle: "mushrooms-250g",
    title: "Mushrooms 250g",
    stock: 14,
    batches: [
      [4, -2],
      [10, 4],
    ],
  },
  {
    handle: "chicken-breast-500g",
    title: "Chicken breast 500g",
    stock: 12,
    batches: [
      [5, 1],
      [7, 4],
    ],
  },
  {
    handle: "beef-mince-500g",
    title: "Beef mince 500g",
    stock: 14,
    batches: [[14, 3]],
  },
  {
    handle: "pork-sausages-6-pack",
    title: "Pork sausages 6-pack",
    stock: 10,
    batches: [[10, 6]],
  },
  { handle: "bacon-250g", title: "Bacon 250g", stock: 16, batches: [[16, 12]] },
  {
    handle: "lamb-chops-400g",
    title: "Lamb chops 400g",
    stock: 8,
    batches: [[8, 5]],
  },
  {
    handle: "salmon-fillet-300g",
    title: "Salmon fillet 300g",
    stock: 9,
    batches: [
      [6, 2],
      [6, 4],
    ],
  },
  {
    handle: "prawns-250g",
    title: "Prawns 250g",
    stock: 10,
    batches: [[10, -4]],
  },
  {
    handle: "turkey-slices-150g",
    title: "Turkey slices 150g",
    stock: 14,
    batches: [[14, 9]],
  },
  {
    handle: "smoked-ham-200g",
    title: "Smoked ham 200g",
    stock: 15,
    batches: [[15, 11]],
  },
  {
    handle: "prosciutto-100g",
    title: "Prosciutto 100g",
    stock: 10,
    batches: [[10, 25]],
  },
  {
    handle: "hummus-200g",
    title: "Hummus 200g",
    stock: 18,
    batches: [
      [8, 3],
      [10, 10],
    ],
  },
  {
    handle: "fresh-pasta-400g",
    title: "Fresh pasta 400g",
    stock: 12,
    batches: [[12, 8]],
  },
  { handle: "tofu-400g", title: "Tofu 400g", stock: 16, batches: [[16, 20]] },
  {
    handle: "coleslaw-300g",
    title: "Coleslaw 300g",
    stock: 12,
    batches: [[12, 2]],
  },
  {
    handle: "orange-juice-1l",
    title: "Orange juice 1L",
    stock: 30,
    batches: [[12, 10]],
  },
  {
    handle: "apple-juice-1l",
    title: "Apple juice 1L",
    stock: 24,
    batches: [[24, 40]],
  },
  {
    handle: "kombucha-330ml",
    title: "Kombucha 330ml",
    stock: 36,
    batches: [[20, 60]],
  },
  {
    handle: "cold-brew-coffee-250ml",
    title: "Cold brew coffee 250ml",
    stock: 20,
    batches: [[20, 35]],
  },
  {
    handle: "frozen-peas-500g",
    title: "Frozen peas 500g",
    stock: 30,
    batches: [[30, 240]],
  },
  {
    handle: "frozen-mixed-berries-500g",
    title: "Frozen mixed berries 500g",
    stock: 18,
    batches: [[18, 300]],
  },
  {
    handle: "vanilla-ice-cream-1l",
    title: "Vanilla ice cream 1L",
    stock: 14,
    batches: [[14, 150]],
  },
  {
    handle: "extra-virgin-olive-oil-500ml",
    title: "Extra virgin olive oil 500ml",
    stock: 20,
    batches: [],
  },
  {
    handle: "jasmine-rice-1kg",
    title: "Jasmine rice 1kg",
    stock: 25,
    batches: [],
  },
  { handle: "honey-350g", title: "Honey 350g", stock: 15, batches: [] },
  {
    handle: "peanut-butter-380g",
    title: "Peanut butter 380g",
    stock: 18,
    batches: [[18, 220]],
  },
  {
    handle: "rolled-oats-1kg",
    title: "Rolled oats 1kg",
    stock: 22,
    batches: [[22, 330]],
  },
];
