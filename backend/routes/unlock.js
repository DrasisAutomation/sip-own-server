const express = require('express');
const router = express.Router();
const sip = require('../sip');

router.post('/', (req, res) => {
  const success = sip.sendDtmf();
  if (success) {
    res.status(200).json({ success: true, message: 'Unlock command sent' });
  } else {
    res.status(400).json({ success: false, message: 'No active call to unlock' });
  }
});

module.exports = router;
