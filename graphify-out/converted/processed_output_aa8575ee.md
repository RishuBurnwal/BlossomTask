<!-- converted from processed_output.xlsx -->

## Sheet: Sheet1
| order_id | task_id | ship_name | ship_city | ship_state | ship_zip | last_processed_at | ord_id | ord_date | ship_care_of | ship_address | ship_address_unit | ship_country | ship_phone_day | ship_phone_eve | ship_date | ship_date_original | delivery_date | ord_occasion | ord_message | ord_instruct | ord_status | ship_loc_id | domain | itemlist | matched_name | funeral_home_name | funeral_address | funeral_phone | service_type | funeral_date | funeral_time | visitation_date | visitation_time | ceremony_date | ceremony_time | delivery_recommendation_date | delivery_recommendation_time | delivery_recommendation_location | special_instructions | status | AI Accuracy Score | source_urls | notes | raw_api_response | raw_openai_response | processed_at |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 4272139 | 40471064 | George Grimes Jr | Arlington | TX | 76017 | 2026-04-21T22:29:56.825636 | 4272139 | 2026-04-21T00:00:00 | Rush Creek Church - Green Oaks | 2350 SW Green Oaks Blvd |  | USA | 8174687729 |  | 2026-04-25T00:00:00 | 2026-04-25T00:00:00 | 2026-04-25T00:00:00 | Funeral Service | Our deepest sympathy to the Grimes family. Love The LaHaise family.
 | Deliver it before the Service starts.
A celebration of life
April 25, 2026 Saturday
2PM
Rush Creek Church - Green Oaks Campus
2350 SW Green Oaks Blvd, Arlington, TX 76017, United States
+1 8174687729
 | Wired | CHU | bloomflowerdelivery.com | [{'itm_ID': '17105', 'itm_price': 79.99, 'itm_Qty': 1, 'Title': 'Lily Basket - Deluxe', 'Description': 'Peace lily in a round  ceramic pot.', 'type_id': 4}] | George Grimes Jr | Rush Creek Church - Green Oaks Campus | 2350 SW Green Oaks Blvd, Arlington, TX 76017 | +1 8174687729 | church | 2026-04-25 | 2:00 PM |  |  | 2026-04-25 | 2:00 PM | 2026-04-25 | Before 2:00 PM | Rush Creek Church - Green Oaks Campus, 2350 SW Green Oaks Blvd, Arlington, TX 76017 | Deliver before the service starts. Celebration of Life service begins at 2:00 PM on April 25, 2026 (Saturday). NOTE: Current date is April 27, 2026 — the service date has already passed. | Review | 72 | [] | ord_instruct was used as the primary and highest-value evidence source. It provides a complete and internally consistent set of details: deceased name (George Grimes Jr), service type (Celebration of Life), date (April 25, 2026, Saturday), time (2:00 PM), venue (Rush Creek Church - Green Oaks Campus), address (2350 SW Green Oaks Blvd, Arlington, TX 76017), and phone (+1 8174687729). The venue name and address in ord_instruct exactly match ship_care_of and ship_address, providing strong corroborating alignment. No independent obituary/detail URL was found via web search to confirm identity externally; no legacy.com, newspaper, or funeral home obituary detail page was located for George Grimes Jr in Arlington, TX. Identity is treated as plausible and strongly supported by ord_instruct + venue alignment, but the absence of a direct obituary/detail URL prevents a full Found determination. Status is Review rather than Found due to lack of an independent corroborating obituary/detail URL. Additionally, the current date (April 27, 2026) is two days after the service date (April 25, 2026), meaning the service has already occurred — this is flagged as a critical timing limitation. Delivery recommendation is preserved from ord_instruct as instructed, but operational fulfillment may no longer be applicable. | ```json
{
  "matched_name": "George Grimes Jr",
  "funeral_home_name": "Rush Creek Church - Green Oaks Campus",
  "funeral_address": "2350 SW Green Oaks Blvd, Arlington, TX 76017",
  "funeral_phone": "+1 8174687729",
  "service_type": "church",
  "funeral_date": "2026-04-25",
  "funeral_time": "2:00 PM",
  "visitation_date": "",
  "visitation_time": "",
  "ceremony_date": "2026-04-25",
  "ceremony_time": "2:00 PM",
  "delivery_recommendation_date": "2026-04-25",
  "delivery_recommendation_time": "Before 2:00 PM",
  "delivery_recommendation_location": "Rush Creek Church - Green Oaks Campus, 2350 SW Green Oaks Blvd, Arlington, TX 76017",
  "special_instructions": "Deliver before the service starts. Celebration of Life service begins at 2:00 PM on April 25, 2026 (Saturday). NOTE: Current date is April 27, 2026 — the service date has already passed.",
  "status": "Review",
  "AI Accuracy Score": 72,
  "source_urls": [],
  "notes": "ord_instruct was used as the primary and highest-value evidence source. It provides a complete and internally consistent set of details: deceased name (George Grimes Jr), service type (Celebration of Life), date (April 25, 2026, Saturday), time (2:00 PM), venue (Rush Creek Church - Green Oaks Campus), address (2350 SW Green Oaks Blvd, Arlington, TX 76017), and phone (+1 8174687729). The venue name and address in ord_instruct exactly match ship_care_of and ship_address, providing strong corroborating alignment. No independent obituary/detail URL was found via web search to confirm identity externally; no legacy.com, newspaper, or funeral home obituary detail page was located for George Grimes Jr in Arlington, TX. Identity is treated as plausible and strongly supported by ord_instruct + venue alignment, but the absence of a direct obituary/detail URL prevents a full Found determination. Status is Review rather than Found due to lack of an independent corroborating obituary/detail URL. Additionally, the current date (April 27, 2026) is two days after the service date (April 25, 2026), meaning the service has already occurred — this is flagged as a critical timing limitation. Delivery recommendation is preserved from ord_instruct as instructed, but operational fulfillment may no longer be applicable."
}
``` | ```json
{
  "matched_name": "George Kirkland Grimes, Jr.",
  "funeral_home_name": "Moore Bowen Road Funeral Home",
  "funeral_address": "",
  "funeral_phone": "",
  "service_type": "church",
  "funeral_date": "2026-04-25",
  "funeral_time": "14:00",
  "visitation_date": "",
  "visitation_time": "",
  "ceremony_date": "",
  "ceremony_time": "",
  "delivery_recommendation_date": "2026-04-25",
  "delivery_recommendation_time": "13:00",
  "delivery_recommendation_location": "Rush Creek Church - Green Oaks Campus, 2350 SW Green Oaks Blvd, Arlington, TX 76017",
  "special_instructions": "Deliver it before the Service starts.",
  "status": "Found",
  "AI Accuracy Score": 95,
  "source_urls": [
    "https://www.dignitymemorial.com/obituaries/arlington-tx/george-grimes-jr-12819493"
  ],
  "notes": "ord_instruct was used; strongest source type found: direct obituary detail page; identity was exact; timing evidence is complete and aligns with ord_instruct; final status chosen due to strong identity match and complete schedule evidence."
}
``` | 2026-04-27T20:36:48 |
| 5558664 | 40471058 | Shuai Yuan Lun | Gormley | ON | L0H1G0 | 2026-04-21T22:29:58.492528 | 5558664 | 2026-04-21T00:00:00 | Highland Hills Funeral Home & Cemetery (Crematorium) | 12492 Woodbine Ave |  | Canada | 9058880729 |  | 2026-04-23T00:00:00 | 2026-04-23T00:00:00 | 2026-04-23T00:00:00 | Funeral Service | To Mr. Shuai Lun's Family, We are deeply sorry for the passing for Mr. Shuai. He was a close friend who dedicated his entire career to the cookware industry and made a significant contributions to the Tramontina Group. He will be missed. May he rest in peace. | Please deliver before 5PM. | New | FNR | blossomflowerdelivery.com | [{'itm_ID': '17162', 'itm_price': 186.99, 'itm_Qty': 1, 'Title': 'Sympathy Wreath - Premium', 'Description': 'All white cushion mums arranged on a standing  open funeral wreath with a small arrangement  made of  white roses and ivy on the  top left', 'type_id': 4}] |  | Highland Hills Funeral Home & Cemetery (Crematorium) | 12492 Woodbine Ave, Gormley, ON L0H 1G0 |  | funeral_home |  |  |  |  |  |  |  | before 5:00 PM | Highland Hills Funeral Home & Cemetery (Crematorium), 12492 Woodbine Ave, Gormley, ON L0H 1G0 | Please deliver before 5PM. | Review | 42 | [] | ord_instruct was parsed first and contains only a delivery timing instruction ('Please deliver before 5PM') with no service date, visitation date, or schedule evidence. No explicit date is provided in ord_instruct, so delivery_recommendation_date is left empty. Web searches for 'Shuai Yuan Lun obituary Gormley ON', 'Shuai Yuan Lun Highland Hills Funeral Home obituary', and related queries returned no direct obituary or detail page for the deceased. The venue — Highland Hills Funeral Home & Cemetery (Crematorium) at 12492 Woodbine Ave, Gormley, ON — is a verifiable real funeral home, and the ship_address and ship_care_of are consistent with a known funeral facility in the Gormley, Ontario area. However, no direct obituary/detail URL was found for 'Shuai Yuan Lun,' no matched deceased name could be confirmed from obituary sources, and no service/visitation/funeral date or time was found from any credible source. Identity match is unconfirmed — no obituary record found. Venue is plausible and address-consistent but a venue alone cannot justify Found status. Status is Review because meaningful venue evidence exists and ord_instruct provides a delivery timing instruction, but there is insufficient identity confirmation, no obituary/detail URL, and no schedule evidence to elevate to Found. | ```json
{
  "matched_name": "",
  "funeral_home_name": "Highland Hills Funeral Home & Cemetery (Crematorium)",
  "funeral_address": "12492 Woodbine Ave, Gormley, ON L0H 1G0",
  "funeral_phone": "",
  "service_type": "funeral_home",
  "funeral_date": "",
  "funeral_time": "",
  "visitation_date": "",
  "visitation_time": "",
  "ceremony_date": "",
  "ceremony_time": "",
  "delivery_recommendation_date": "",
  "delivery_recommendation_time": "before 5:00 PM",
  "delivery_recommendation_location": "Highland Hills Funeral Home & Cemetery (Crematorium), 12492 Woodbine Ave, Gormley, ON L0H 1G0",
  "special_instructions": "Please deliver before 5PM.",
  "status": "Review",
  "AI Accuracy Score": 42,
  "source_urls": [],
  "notes": "ord_instruct was parsed first and contains only a delivery timing instruction ('Please deliver before 5PM') with no service date, visitation date, or schedule evidence. No explicit date is provided in ord_instruct, so delivery_recommendation_date is left empty. Web searches for 'Shuai Yuan Lun obituary Gormley ON', 'Shuai Yuan Lun Highland Hills Funeral Home obituary', and related queries returned no direct obituary or detail page for the deceased. The venue — Highland Hills Funeral Home & Cemetery (Crematorium) at 12492 Woodbine Ave, Gormley, ON — is a verifiable real funeral home, and the ship_address and ship_care_of are consistent with a known funeral facility in the Gormley, Ontario area. However, no direct obituary/detail URL was found for 'Shuai Yuan Lun,' no matched deceased name could be confirmed from obituary sources, and no service/visitation/funeral date or time was found from any credible source. Identity match is unconfirmed — no obituary record found. Venue is plausible and address-consistent but a venue alone cannot justify Found status. Status is Review because meaningful venue evidence exists and ord_instruct provides a delivery timing instruction, but there is insufficient identity confirmation, no obituary/detail URL, and no schedule evidence to elevate to Found."
}
``` | {
  "matched_name": "",
  "funeral_home_name": "Highland Hills Funeral Home & Cemetery",
  "funeral_address": "12492 Woodbine Avenue, Gormley, ON L0H 1G0",
  "funeral_phone": "(905) 888-0729",
  "service_type": "funeral_home",
  "funeral_date": "",
  "funeral_time": "",
  "visitation_date": "",
  "visitation_time": "",
  "ceremony_date": "",
  "ceremony_time": "",
  "delivery_recommendation_date": "",
  "delivery_recommendation_time": "",
  "delivery_recommendation_location": "",
  "special_instructions": "",
  "status": "NotFound",
  "AI Accuracy Score": 0,
  "source_urls": [
    "https://gormley.cdncompanies.com/funeral-home/highland-hills-gormley/",
    "https://www.yellowpages.ca/bus/Ontario/Gormley/Highland-Hills-Funeral-Home-Cemetery/101083561.html"
  ],
  "notes": "No obituary or service information found for 'Shuai Yuan Lun' in Gormley, ON. The funeral home details were confirmed, but no matching records were located. Status set to NotFound due to lack of evidence."
} | 2026-04-27T20:37:17 |
| 5457085 | 40471045 | Dale Boyce | Odessa | ON | K0H2H0 | 2026-04-21T22:30:00.212228 | 5457085 | 2026-04-21T00:00:00 | Payne Funeral Home | Inc. 178 Main St. |  | Canada | 6133867373 |  | 2026-04-22T00:00:00 | 2026-04-22T00:00:00 | 2026-04-22T00:00:00 | Funeral Service | Our deepest condolences. Ruth Gorrie Dave & Kathy Balsillie Andrew & Sheila Gorrie |  | New | FNR | blossomflowerdelivery.com | [{'itm_ID': '15768', 'itm_price': 79.99, 'itm_Qty': 1, 'Title': 'Calming Comfort - Deluxe', 'Description': 'Blue iris,  white spray roses, and white oriental lilies arranged  tall and one-sided  in a cobalt blue vase with eucalyptus and misty blue', 'type_id': 4}] | Dale Boyce | Payne Funeral Home | 178 Main St., Odessa, ON K0H 2H0 |  | funeral_home |  |  |  |  |  |  |  |  | Payne Funeral Home, 178 Main St., Odessa, ON K0H 2H0 |  | Review | 52 | [] | ord_instruct was empty and provided no schedule, delivery, or venue evidence. Search was conducted for 'Dale Boyce obituary Odessa Ontario', 'Dale Boyce Payne Funeral Home obituary Odessa ON', and related queries. Payne Funeral Home at 178 Main St., Odessa, ON K0H 2H0 is a verifiable funeral home in Odessa, Ontario, Canada, consistent with ship_address and ship_care_of. However, no direct obituary or detail page for a deceased named Dale Boyce could be confirmed at this venue or from any credible obituary source (Legacy.com, funeral home obituary pages, newspaper sources). No service dates, times, visitation, or ceremony details were found. Identity is plausible based on venue name and address alignment with ship inputs, but cannot be confirmed as Found without a direct obituary/detail URL and at least one usable schedule signal. Status set to Review because the venue is credible and identifiable but obituary identity and schedule evidence are absent. Confidence scored at 52 reflecting venue-only support without obituary/detail URL confirmation. | ```json
{
  "matched_name": "Dale Boyce",
  "funeral_home_name": "Payne Funeral Home",
  "funeral_address": "178 Main St., Odessa, ON K0H 2H0",
  "funeral_phone": "",
  "service_type": "funeral_home",
  "funeral_date": "",
  "funeral_time": "",
  "visitation_date": "",
  "visitation_time": "",
  "ceremony_date": "",
  "ceremony_time": "",
  "delivery_recommendation_date": "",
  "delivery_recommendation_time": "",
  "delivery_recommendation_location": "Payne Funeral Home, 178 Main St., Odessa, ON K0H 2H0",
  "special_instructions": "",
  "status": "Review",
  "AI Accuracy Score": 52,
  "source_urls": [],
  "notes": "ord_instruct was empty and provided no schedule, delivery, or venue evidence. Search was conducted for 'Dale Boyce obituary Odessa Ontario', 'Dale Boyce Payne Funeral Home obituary Odessa ON', and related queries. Payne Funeral Home at 178 Main St., Odessa, ON K0H 2H0 is a verifiable funeral home in Odessa, Ontario, Canada, consistent with ship_address and ship_care_of. However, no direct obituary or detail page for a deceased named Dale Boyce could be confirmed at this venue or from any credible obituary source (Legacy.com, funeral home obituary pages, newspaper sources). No service dates, times, visitation, or ceremony details were found. Identity is plausible based on venue name and address alignment with ship inputs, but cannot be confirmed as Found without a direct obituary/detail URL and at least one usable schedule signal. Status set to Review because the venue is credible and identifiable but obituary identity and schedule evidence are absent. Confidence scored at 52 reflecting venue-only support without obituary/detail URL confirmation."
}
``` | {
  "matched_name": "Dale Boyce",
  "funeral_home_name": "Paul G. Payne Funeral Home",
  "funeral_address": "178 Main St, Odessa, ON K0H 2H0",
  "funeral_phone": "613-386-7373",
  "service_type": "church",
  "funeral_date": "2026-04-24",
  "funeral_time": "12:00 PM",
  "visitation_date": "2026-04-23",
  "visitation_time": "2:00 PM - 4:00 PM",
  "ceremony_date": "2026-04-24",
  "ceremony_time": "12:00 PM",
  "delivery_recommendation_date": "",
  "delivery_recommendation_time": "",
  "delivery_recommendation_location": "",
  "special_instructions": "",
  "status": "Found",
  "AI Accuracy Score": 90,
  "source_urls": [
    "https://www.echovita.com/ca/obituaries/on/odessa/dale-boyce-21339989",
    "https://paynefuneralhome.com/"
  ],
  "notes": "Ord_instruct was not provided. The strongest source found was a direct obituary page. Identity match is exact. Service and visitation dates and times are clearly specified. Status is marked as Found due to strong identity match and complete schedule information."
} | 2026-04-27T20:37:45 |