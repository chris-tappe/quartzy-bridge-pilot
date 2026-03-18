(function () {
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        // 1. Capture Authorization Token if present
        const init = args[1] || {};
        const headers = init.headers;
        if (headers) {
            let token = null;
            if (typeof headers.get === 'function') {
                token = headers.get('Authorization');
            } else {
                token = headers['Authorization'] || headers['authorization'];
            }
            if (token && token.toLowerCase().startsWith('bearer ')) {
                window.postMessage({ type: "VWR_TOKEN_UPDATE", token: token }, "*");
            }
        }

        const response = await originalFetch.apply(this, args);
        const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";

        if (url.includes("/api/product/ordertable") && response.ok) {
            const clonedResponse = response.clone();
            clonedResponse.json().then(data => {
                if (data && data.productRows && data.productRows.length > 0) {
                    const row = data.productRows[0];
                    const priceData = row.prices && row.prices[0] ? row.prices[0] : {};
                    const message = {
                        type: "VWR_INTERCEPTED_DATA",
                        data: {
                            catalogNumber: priceData.skuId || row.catalogNumber,
                            itemName: data.description || row.name,
                            price: priceData.formattedDisplayPrice,
                            unitSize: priceData.uomDescription || "Each",
                            url: window.location.href
                        }
                    };
                    window.postMessage(message, "*");
                }
            }).catch(() => { });
        }

        if (url.includes("/users/current/priceDetails") && response.ok) {
            const clonedResponse = response.clone();
            clonedResponse.json().then(data => {
                if (data && data.articles && data.articles.length > 0) {
                    const article = data.articles[0];
                    const prices = article.uomSpecificPrices || [];
                    if (prices.length > 0) {
                        const priceObj = prices.find(p => (p.uomID || "").toUpperCase() === "EA") || prices[0];
                        const uomMap = { EA: "Each", CS: "Case", PK: "Pack", BX: "Box" };
                        const unitSize = uomMap[(priceObj.uomID || "").toUpperCase()] || priceObj.uomID || "Each";
                        const message = {
                            type: "VWR_PRICE_DETAILS_INTERCEPTED",
                            data: {
                                catalogNumber: article.catalogNumber,
                                price: priceObj.formattedDisplayPrice || (priceObj.value != null ? "$" + priceObj.value.toFixed(2) : null),
                                unitSize,
                                url: window.location.href
                            }
                        };
                        window.postMessage(message, "*");
                    }
                }
            }).catch(() => { });
        }

        return response;
    };
})();
