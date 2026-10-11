-- Live run 1 (F5): Ba's model choice on the Bots screen (PATCH /bots/:name { model }); null = bot.json's
-- model. ADD COLUMN only: no table rebuild, no trigger touched.
ALTER TABLE `bots` ADD `model_override` text;
