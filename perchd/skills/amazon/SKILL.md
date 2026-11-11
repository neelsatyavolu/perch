---
name: amazon
description: Shop on amazon.com - search and filter products, compare prices and ratings, read reviews, check orders. Use for any task about buying, pricing or comparing products on Amazon.
---

# Amazon

## Go straight to the page

- Search: `https://www.amazon.com/s?k=<query>` (URL-encode the query).
- Sort: add `&s=price-asc-rank`, `price-desc-rank`, `review-rank` (average rating) or `date-desc-rank` (newest).
- Price range: add `&rh=p_36:<min>-<max>` in cents, so $25 to $50 is `p_36:2500-5000`. Check the price chip or the results to confirm it applied.
- A product: `https://www.amazon.com/dp/<ASIN>`. Its reviews: `https://www.amazon.com/product-reviews/<ASIN>`.
- The user's orders: `https://www.amazon.com/gp/your-account/order-history`.

## Read results quickly

Pull the first results in one call instead of reading the whole snapshot:

```js
[...document.querySelectorAll('[data-component-type="s-search-result"]')].slice(0, 10).map((r) => ({
  asin: r.dataset.asin,
  title: r.querySelector("h2")?.innerText,
  price: r.querySelector(".a-price .a-offscreen")?.innerText,
  rating: r.querySelector(".a-icon-alt")?.innerText,
  reviews: r.querySelector('[aria-label$="ratings"], .s-underline-text')?.innerText,
  sponsored: /Sponsored/.test(r.innerText),
}))
```

## Notes

- Skip results marked Sponsored unless the user asks for them; they are ads, not the best match.
- A good pick balances rating and number of reviews: 4.6 stars from 10,000 reviews beats 5.0 from 12.
- Prices on the results page can differ from the product page (coupons, other sellers, sizes). Open the product page before quoting a final price.
- Buying waits for the user's approval. Never place an order unless the task asks for it.
