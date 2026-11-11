import {test,expect} from '@playwright/test';

test('a new player can assemble a part, reload and download progress on a static site',async({page})=>{
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');
  await page.getByRole('link',{name:'搭建木作水磨山居'}).click();
  await expect(page.locator('#loading')).toBeHidden({timeout:30000});
  await expect(page.locator('#leveleasy')).toContainText('108');
  await page.locator('#leveleasy').click();
  await page.locator('.tray-piece[data-step="1"]').waitFor();
  const part=await page.locator('.tray-piece[data-step="1"]').boundingBox();
  const target=await page.locator('#placementTarget').boundingBox();
  await page.mouse.move(part.x+part.width/2,part.y+part.height/2);
  await page.mouse.down();
  await page.mouse.move(target.x+target.width/2,target.y+target.height/2,{steps:14});
  await page.mouse.up();
  await page.locator('#knob').waitFor();
  await page.locator('#knob').press('End');
  await expect(page.locator('#tally')).toHaveAttribute('aria-valuenow','1');
  await page.reload();
  await expect(page.locator('#loading')).toBeHidden();
  await expect(page.locator('#tally')).toHaveAttribute('aria-valuenow','1');
  await page.locator('#save').click();
  await expect(page.locator('#exportBlend')).toBeHidden();
  const download=page.waitForEvent('download');
  await page.locator('#downloadCheckpoint').click();
  expect((await download).suggestedFilename()).toMatch(/\.assembly\.json$/);
  expect(errors).toEqual([]);
});

test('the compressed scene opens and can be orbited on a narrow screen',async({page})=>{
  await page.setViewportSize({width:430,height:820});
  await page.goto('/play/spiral-mill/?quality=low');
  await expect(page.locator('#loading')).toBeHidden({timeout:40000});
  await expect(page.locator('#levelhard')).toContainText('129');
  await page.locator('#levelhard').click();
  await expect(page.locator('#viewport canvas')).toBeVisible();
  await page.locator('#preview').click();
  await page.mouse.move(325,320);await page.mouse.down();await page.mouse.move(267,350,{steps:6});await page.mouse.up();
  await expect(page.locator('#preview')).toHaveAttribute('aria-pressed','true');
});
