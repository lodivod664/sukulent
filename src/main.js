#! /usr/bin/env node
const prettifyXml = require("prettify-xml");
const uuidv4 = require("uuid/v4");
const DOMParser = require("xmldom").DOMParser;
const xmlCrypto = require("xml-crypto");
const https = require("https");
const QRCode = require("qrcode");
const { Writable } = require("stream");
const Jimp = require("jimp");
const fsPro = require("fs").promises;

function streamToBuffer() {

	let buffer = Buffer.alloc(0);
	let resolve;
	let promise = new Promise(r => resolve = r);

	let stream = new Writable({
		write(chunk, encoding, callback) {
			buffer = Buffer.concat([buffer, chunk]);
			callback();
		},
		final(callback) {
			resolve(buffer);
			callback();
		}
	});

	stream.buffer = promise;
	return stream;
}

async function load(file) {
	try {
		return (await fsPro.readFile(file, "utf8")).trim();
	} catch (e) {
		throw `Chyba čtení souboru ${file}. ${e.message}`;
	}
}

function extractCerts(cert) {
	let result = [];
	let acc;
	cert.split("\n").forEach(line => {
		if (line === "-----BEGIN CERTIFICATE-----") {
			acc = "";
		} else {
			if (line === "-----END CERTIFICATE-----") {
				result.push(acc);
				acc = undefined;
			} else if (acc !== undefined) {
				acc += line;
			}
		}
	});
	return result;
}

function removeEmptyTexts(parent) {
	let remove = [];
	for (let i = 0; i < parent.childNodes.length; i++) {
		let el = parent.childNodes[i];
		if (el.nodeType === 3 && !el.data.trim()) {
			remove.push(el);
		}
		if (el.nodeType === 1) {
			removeEmptyTexts(el);
		}
	}
	remove.forEach(el => parent.removeChild(el));
}

function signRequest(request, certPem) {

	let doc = new DOMParser().parseFromString(request);
	removeEmptyTexts(doc.documentElement);

	let suklNs = "http://www.sukl.cz/erp/202501";

	let message = doc.createElementNS(suklNs, "Zprava");
	function addToMessage(elName, value) {
		let el = doc.createElement(elName);
		let txt = doc.createTextNode(value);
		el.appendChild(txt);
		message.appendChild(el);
	}
	addToMessage("ID_Zpravy", uuidv4());
	addToMessage("Verze", "202501A");
	addToMessage("Odeslano", new Date().toJSON());
	addToMessage("SW_Klienta", "Sukulent0000");

	let root = doc.documentElement;
	root.appendChild(message);

	request = root.toString();

	let sig = new xmlCrypto.SignedXml(false);

	let extractedCerts = extractCerts(certPem);

	sig.addReference("/*", ["http://www.w3.org/2000/09/xmldsig#enveloped-signature"], "http://www.w3.org/2001/04/xmlenc#sha256");
	sig.signatureAlgorithm = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
	sig.references[0].isEmptyUri = true;
	sig.signingKey = certPem;
	sig.keyInfoProvider = {
		getKeyInfo(signingKey, prefix) {
			return `<X509Data><X509SubjectName>A subject...</X509SubjectName>${extractedCerts.map(c => "<X509Certificate>" + c + "</X509Certificate>").join("")}</X509Data>`;
		}
	};
	sig.computeSignature(request);
	request = sig.getSignedXml();

	request = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header/><soapenv:Body>${request}</soapenv:Body></soapenv:Envelope>`;

	return request;
}

async function sendRequest(request, username, password, pem) {

	return new Promise((resolve, reject) => {

		const options = {
			hostname: "lekar-soap.erecept.sukl.cz",
			port: 443,
			path: "/cuer/Lekar",
			method: "POST",
			key: pem,
			cert: pem,
			auth: `${username}:${password}`,
			headers: {
				"Content-Type": "application/soap+xml; charset=utf-8"
			}
		};

		const req = https.request(options, res => {

			reply = "";

			res.on("data", d => {
				reply += d.toString();
			});

			res.on("end", () => {
				resolve(reply);
			});

		});

		req.on("error", (e) => {
			reject(e);
		});

		req.end(request, "utf8");

	});

}

function removeSoapEnvelope(xml) {
	let doc = new DOMParser().parseFromString(xml);
	let soapBody = doc.getElementsByTagNameNS("http://schemas.xmlsoap.org/soap/envelope/", "Body")[0];
	if (!soapBody) {
		return xml;
	}

	for (let i = 0; i < soapBody.childNodes.length; i++) {
		if (soapBody.childNodes[i].nodeType === 1) {
			return soapBody.childNodes[i].toString();
		}
	}

	throw "SOAP body v odpovědi neobsahuje žádný element";
}

function formatAsSoapError(error) {

	error = error.message || error;

	return `
<soap:Fault xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
<faultcode>soap:Client</faultcode>
<faultstring>${error}</faultstring>
</soap:Fault> 
`;

}

async function saveReply(reply) {
	await fsPro.writeFile("reply.xml", reply, "utf8");
}

async function saveQrCode(request, reply) {

	let qrFile = "qr.jpg";

	let requestDoc = new DOMParser().parseFromString(request);
	let platnostDo = requestDoc.getElementsByTagName("ZalozeniPredpisuDotaz")[0].getElementsByTagName("Doklad")[0].getElementsByTagName("PlatnostDo")[0].textContent;
	platnostDo = platnostDo.replace(/-/g, "");

	let replyDoc = new DOMParser().parseFromString(reply);
	let replyNs = "http://www.sukl.cz/erp/202501";
	let elZPD = replyDoc.getElementsByTagNameNS(replyNs, "ZalozeniPredpisuOdpoved")[0];
	if (elZPD) {
		console.info("Ukládám QR...");

		let idDokladu = elZPD.getElementsByTagNameNS(replyNs, "Doklad")[0].getElementsByTagNameNS(replyNs, "ID_Dokladu")[0].textContent
		let qrText = `https://epreskripce.cz/erp?i=${idDokladu}&d=${platnostDo}`;

		let pngStream = streamToBuffer();
		await QRCode.toFileStream(pngStream, qrText, {
			type: "png"
		});

		let pngBuffer = await pngStream.buffer;
		let image = await Jimp.read(pngBuffer);
		await image.writeAsync(qrFile);
	} else {
		try {
			await fsPro.unlink(qrFile);
		} catch (e) {
			if (e.code !== "ENOENT") {
				throw e;
			}
		}
	}
}

async function start() {

	let reply;

	try {

		console.info("Načítám data...");

		let request = await load("request.xml");
		let certPerson = await load("cert-person.pem");
		let certSuklPem = await load("cert-sukl.pem");
		let authUsername = await load("auth-username.txt");
		let authPassword = await load("auth-password.txt");

		console.info("Podepisuji XML...");
		let signedRequest = signRequest(request, certPerson);

		console.info("Odesílám požadavek...");
		reply = await sendRequest(signedRequest, authUsername, authPassword, certSuklPem);
		reply = prettifyXml(removeSoapEnvelope(reply));

		await saveQrCode(request, reply);

	} catch (e) {
		console.error(e);
		reply = formatAsSoapError(e);
	}

	console.info("Ukládám odpověď...");
	await saveReply(reply);

	console.info("Hotovo.");
}

start().catch(console.error);


