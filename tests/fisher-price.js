test('test', async ({ page }) => {
    await page.routeFromHAR('/Users/chris.tappe/Development/quartzy-bridge-pilot-cursor/vendor_traffic.har');
    await page.goto('https://www.fishersci.com/us/en/home.html');
    await page.getByRole('button', { name: 'Reject All' }).click();
    await page.getByRole('link', { name: 'Explore Fisher Scientific now' }).click();
    await page.getByRole('combobox', { name: 'Search' }).click();
    await page.getByRole('combobox', { name: 'Search' }).fill('4488 pipet');
    await page.getByRole('combobox', { name: 'Search' }).press('Enter');
    await page.getByRole('combobox', { name: 'Search' }).press('Enter');
    await page.getByRole('combobox', { name: 'Search' }).click();
    await page.getByRole('combobox', { name: 'Search' }).fill('4488');
    await page.getByRole('combobox', { name: 'Search' }).press('Enter');
    await page.getByRole('link', { name: 'Corning™ Stripette™ Paper/' }).click();
    await page.locator('#pricing_container').getByText('$119.00').click();
    await page.locator('[id="attributeButton_Volume(Metric)_2"]').click();
    await page.locator('#pricing_container').getByText('$112.00').click();
  });