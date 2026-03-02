(function () {
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        const response = await originalFetch.apply(this, args);
        const url = args[0];

        if (typeof url === 'string' && url.includes('/api/product/ordertable')) {
            // Clone response to read it without consuming it for the page
            const clonedResponse = response.clone();
            clonedResponse.json().then(data => {
                console.log("[Quartzy Bridge] Intercepted OrderTable Response", data);
                if (data && data.productRows && data.productRows.length > 0) {
                    // We'll take the first row as the primary one for the page
                    const row = data.productRows[0];
                    const priceData = row.prices && row.prices[0] ? row.prices[0] : {};

                    const message = {
                        type: "VWR_INTERCEPTED_DATA",
                        data: {
                            catalogNumber: row.catalogNumber,
                            itemName: data.description || row.name,
                            price: priceData.formattedDisplayPrice,
                            unitSize: priceData.uomDescription || "Each",
                            url: window.location.href
                        }
                    };
                    window.postMessage(message, "*");
                }
            }).catch(err => console.error("[Quartzy Bridge] Error parsing intercepted JSON", err));
        }

        return response;
    };
})();
