---
name: google-maps
description: Find places, opening hours, reviews and directions on Google Maps. Use for tasks about where something is, how to get there, travel times, or nearby businesses.
---

# Google Maps

Open Maps with documented URLs instead of typing into the search box:

- Search for a place or category: `https://www.google.com/maps/search/?api=1&query=<text>` (for example `coffee near Union Square San Francisco`)
- Directions: `https://www.google.com/maps/dir/?api=1&origin=<from>&destination=<to>&travelmode=<driving|walking|bicycling|transit>`
  - Add `&waypoints=<a>|<b>` for stops (not for transit).
  - Leave out `origin` to start from the user's location.
- A map centred on a point: `https://www.google.com/maps/@?api=1&map_action=map&center=<lat>,<lng>&zoom=<1-21>`

URL-encode every value.

## Reading results

- A search with many results shows a list on the left; each entry has the name, rating, review count, category, address and whether it is open now. Click an entry for hours, phone, website and popular times.
- The hours table shows every day of the week once you click the hours line.
- Directions show several routes with time and distance; the first is the fastest. Transit routes list departure and arrival times and the lines used.
- The map itself is a canvas. Read details from the side panel with snapshot; use screenshot only when you need to see the map.

## Notes

- Results depend on the location in the query. Always put the city or area in the search text so Maps does not use the network's guess.
- Ratings and review counts change; report them with the date you read them when the task asks for exact figures.
