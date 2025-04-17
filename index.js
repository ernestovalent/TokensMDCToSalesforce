require("dotenv").config();
const { create } = require("xmlbuilder2");
const crypto = require("crypto");
const axios = require("axios");
const fs = require("fs").promises;
const path = require("path");
const xml2js = require("xml2js");
const csvWritter = require("csv-writer").createObjectCsvWriter;

let step = 0;
const showVerbose = process.env.SHOW_VERBOSE === "true";

function getYesterdayDate() {
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    let day = yesterday.getDate();
    let month = yesterday.getMonth() + 1;
    let year = yesterday.getFullYear();
    const dateFormart = `${day < 10 ? "0" + day : day}/${month < 10 ? "0" + month : month
        }/${year}`;
    printLog("Getting yesterday date", { date: dateFormart });
    return dateFormart;
}

function createBodyToEncrypt() {
    const data = {
        root: {
            user: process.env.MIT_USER,
            pwd: process.env.MIT_PWD,
            id_company: process.env.MIT_COMPANY,
            date: getYesterdayDate(),
            id_branch: {},
            reference: {},
        },
    };
    const xml = create(data);
    toReturn = "";
    for (const children of xml.root().node.childNodes) {
        toReturn += `<${children.nodeName}>`;
        if (children.childNodes[0]) {
            toReturn += `${children.childNodes[0].data}`;
        }
        toReturn += `</${children.nodeName}>`;
    }
    printLog("Creating body to encrypt", { xml: toReturn });
    return toReturn;
}

function createIvrKey() {
    if (process.env.MIT_KEY === undefined) {
        console.error("MIT_KEY is not defined in .env file");
        return;
    }
    return (binKey = Buffer.from(process.env.MIT_KEY, "hex"));
}

function encryptString(xmlText) {
    const key = createIvrKey();
    const cipher = crypto.createCipheriv("aes-128-cbc", key, key);
    let textEncrypted = cipher.update(xmlText);
    textEncrypted = Buffer.concat([textEncrypted, cipher.final()]);
    textEncrypted = Buffer.concat([key, textEncrypted]);
    printLog("Encrypting body", { keyBase64: key.toString("base64"),textEncrypted: textEncrypted.toString("base64").length });
    return textEncrypted;
}

function decryptString(encryptedText) {
    printLog("Decrypting body", { encryptedText: encryptedText.length });
    if (process.env.MIT_KEY === undefined) {
        console.error("MIT_KEY is not defined in .env file");
        return;
    }
    if (encryptedText === undefined) {
        console.error("Encrypted text is undefined");
        return;
    }
    //encryptedText origing is in Base64
    const textBase64 = Buffer.from(encryptedText, "base64");
    const textHexadecimal = textBase64.toString("hex");
    //Get first 32 characters for iv
    const iv = Buffer.from(textHexadecimal.substring(0, 32), "hex");
    const key = createIvrKey();
    //Get the rest of the string for encrypted text
    const ciphertext = Buffer.from(textHexadecimal.substring(32), "hex");
    //Decrypt
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    printLog("Decrypting success", { decrypted: decrypted.toString("utf8").length });
    return decrypted.toString("utf8");
}

function createBodyRequest(textEncrypted) {
    const dataToXML = {
        "soapenv:Envelope": {
            "@xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
            "@xmlns:xsd": "http://www.w3.org/2001/XMLSchema",
            "@xmlns:wst": "http://wstrans.cpagos",
            "@xmlns:soapenv": "http://schemas.xmlsoap.org/soap/envelope/",
            "soapenv:Body": {
                "wst:transacciones": {
                    "wst:in0": process.env.MIT_XML,
                    "wst:in1": textEncrypted.toString("base64"),
                    "wst:in2": {},
                    "wst:in3": {},
                    "wst:in4": {},
                    "wst:in5": {},
                }
            }
        }
    };
    const xml = create({ encoding: "UTF-8" }, dataToXML).end();
    printLog("Creating body request", { xml: xml });
    return xml;
}

async function sendRequestToMit(xmlText) {
    printLog("Sending request to MIT", { url: process.env.MIT_URL });
    const response = await axios
    .post(process.env.MIT_URL, xmlText, {
        headers: {
            "Content-Type": "text/xml; charset=utf-8",
        },
    });
    printLog("Response API success", { code: response.status });
    return response.data;
}

async function saveResponse(xml) {
    if (xml === undefined || xml.length === 0) {
        console.error("XML response is undefined");
        return;
    }
    const dateStr = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const fileName = path.join(__dirname, "results", `${dateStr}-response.xml`);
    printLog("Saving response to file", { fileName: fileName });
    await fs.writeFile(fileName, xml, "utf8");
    printLog("File saved", { fileName: fileName });
    return fileName;
}

async function readXmlFile(filePath) {
    if (filePath === undefined || filePath.length === 0) {
        console.error("File path is undefined");
        return;
    }
    const file = await fs.readFile(filePath, "utf8");
    if (file === undefined || file.length === 0) {
        console.error("File is undefined");
        return;
    }
    const xml = readXml(file);
    printLog("Reading XML file", { filePath: filePath });
    return xml;
}

async function readXml(xmlText) {
    const parser = new xml2js.Parser({
        mergeAttrs: false,
        explicitRoot: false,
        explicitArray: false,
    });

    const result = await parser.parseStringPromise(xmlText);
    printLog("Parsing XML", { result: Object.keys(result) });
    return result;
}

function filterTokens(tokens) {
    printLog("Filtering tokens", { tokens: tokens.length });
    let filtered = tokens.filter((item) => {
        return (
            item.cc_tp !== undefined &&
            item.cc_tp !== "DISCOVER" &&
            item.cc_tp !== "DINERS"
        );
    });
    printLog("Filtered tokens", { filtered: filtered.length });
    return filtered;
}

function exportCSV(data) {
    printLog("Exporting to CSV", { data: data.length });
    if (data.length === 0) {
        console.error("No hay datos para exportar a CSV");
        return;
    }
    const dateStr = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const csvWriter = csvWritter({
        path: path.join(__dirname, "results", `${dateStr}-output.csv`),
        header: [
            { id: "nu_operaion", title: "nu_operacion__c" },
            { id: "cd_usuario", title: "cd_usuario__c" },
            { id: "cd_empresa", title: "cd_empresa__c" },
            { id: "nu_sucursal", title: "nu_sucursal__c" },
            { id: "nu_afiliacion", title: "nu_afiliacion__c" },
            { id: "nb_referencia", title: "nb_referencia__c" },
            { id: "cc_nombre", title: "cc_nombre__c" },
            { id: "cc_num", title: "cc_num__c" },
            { id: "cc_tp", title: "cc_tp__c" },
            { id: "nu_importe", title: "nu_importe__c" },
            { id: "cd_tipopago", title: "cd_tipopago__c" },
            { id: "cd_tipocobro", title: "cd_tipocobro__c" },
            { id: "cd_instrumento", title: "cd_instrumento__c" },
            { id: "nb_response", title: "nb_response__c" },
            { id: "nu_auth", title: "nu_auth__c" },
            { id: "fh_registro", title: "fh_registro__c" },
            { id: "fh_bank", title: "fh_bank__c" },
            { id: "cd_usrtransaccion", title: "cd_usrtransaccion__c" },
            { id: "tp_operacion", title: "tp_operacion__c" },
            { id: "nb_currency", title: "nb_currency__c" },
            { id: "cd_resp", title: "cd_resp__c" },
            { id: "nb_resp", title: "nb_resp__c" },
            { id: "token", title: "token__c" },
        ],
    });
    return csvWriter.writeRecords(data);
}

function printLog(title, details = {}){
    step++;
    console.log(`${step}: ${title}`);
    if (showVerbose && Object.keys(details).length > 0) {
        for (const key in details) {
            console.log(`  ${key}: ${details[key]}`);
        }
    }
}

async function main() {
    //1. Get XML Body plain text
    const plainBody = createBodyToEncrypt();
    //2. Encrypt XML Body
    const encryptedBody = encryptString(plainBody);
    //3. Get final body to Soap API
    const body = createBodyRequest(encryptedBody);
    //4. Send request to API
    const responseXml = await sendRequestToMit(body);
    const xmlFile = await saveResponse(responseXml);
    const encryptedText = await readXmlFile(xmlFile);
    //5. Decrypt response
    const decryptedTextInXml = decryptString(encryptedText["soap:Body"]["ns1:transaccionesResponse"]["ns1:out"]);
    //6. Save response to file
    const tokensArray = await readXml(decryptedTextInXml);
    //7. Filter tokens
    const filteredTokens = filterTokens(tokensArray["transaccion"]);
    //8. Export to CSV
    await exportCSV(filteredTokens);
}

main().catch((error) => {
    console.error("========> Fatal Error: ", error);
}).finally(() => {
    console.log("\n=================================\n       * CSV file created! * \n=================================\n");
});