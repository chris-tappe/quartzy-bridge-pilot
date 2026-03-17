import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('https://www.fishersci.com/us/en/home.html');
  await page.getByRole('button', { name: 'Reject All' }).click();
  await page.getByRole('button', { name: 'Reject All' }).click();
  await page.locator('#quickorder-link-a').click();
  await page.locator('#qa_catNumber_0').click();
  await page.locator('#qa_catNumber_0').fill('4488');
  await page.getByText('44888G').click();
  await page.getByText('44888G').click();
  await page.getByRole('row', { name: '4488 Fisher Catalog Number' }).getByLabel('Text field').click();
  await page.getByRole('row', { name: '4488 Fisher Catalog Number' }).getByLabel('Text field').press('Enter');
  await page.getByRole('row', { name: 'Product Image Corning™' }).getByLabel('Quantity').fill('12');
  await page.getByRole('row', { name: 'Product Image Corning™' }).getByLabel('Quantity').press('Enter');
  await page.locator('#qa_catNumber_1').click();
  await page.locator('#qa_catNumber_1').fill('07200574');
  await page.locator('#qa_catNumber_1').press('Enter');
  await page.getByRole('link', { name: 'Add all to Cart' }).click();
  await page.getByText('$119.00').first().click();
  await page.getByText('$119.00').first().dblclick();
  await page.locator('#fs').press('ControlOrMeta+c');
  await page.getByText('$119.00').first().click();
  await page.getByText('$').nth(5).dblclick();
  await page.locator('#fs').press('ControlOrMeta+c');
  await page.getByText('/ Case of').first().click();
  await page.locator('#fs').press('ControlOrMeta+c');
});