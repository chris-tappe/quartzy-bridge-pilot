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
        const url = args[0];

        if (typeof url === 'string' && url.includes('/api/product/ordertable')) {
            const clonedResponse = response.clone();
            clonedResponse.json().then(data => {
                if (data && data.productRows && data.productRows.length > 0) {
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
            }).catch(() => { });
        }

        return response;
    };
})();
