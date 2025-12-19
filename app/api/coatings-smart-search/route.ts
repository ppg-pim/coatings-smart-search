import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const openaiApiKey = process.env.OPENAI_API_KEY!

const supabase = createClient(supabaseUrl, supabaseKey)
const openai = new OpenAI({ apiKey: openaiApiKey })

// ============================================================================
// TYPES & CONSTANTS
// ============================================================================

type ProductRecord = Record<string, any>

interface AIQueryPlan {
  intent: 'comparison' | 'lookup' | 'list' | 'count' | 'analytical'
  searchTerms: string[]
  filters?: {
    family?: string
    productType?: string
    productModel?: string
  }
  requiresMultipleProducts: boolean
  explanation: string
}

interface EnhancedQuery {
  originalQuery: string
  enhancedQuery: string
  searchIntent: string
  domainTerms: string[]
  technicalRequirements: string[]
  expectedProductTypes: string[]
}

interface FilterCache {
  families: string[]
  productTypes: string[]
  productModels: string[]
  timestamp: number
  ttl: number
}

interface QueryAnalysis {
  isSingleWord: boolean
  isMultiWord: boolean
  wordCount: number
  requiresAllWords: boolean
  searchStrategy: 'semantic-first' | 'keyword-first' | 'hybrid'
}

// 🎯 OPTIMIZED TOKEN LIMITS
const MAX_TOKENS = 30000
const MAX_INPUT_TOKENS = 20000
const MAX_DETAILED_PRODUCTS = 20
const MAX_SUMMARY_PRODUCTS = 100
const MAX_FIELD_LENGTH = 200

// 🎯 Semantic Search Configuration
const EMBEDDING_MODEL = 'text-embedding-3-small'
const SEMANTIC_SIMILARITY_THRESHOLD = 0.45 // Lowered from 0.50
const SEMANTIC_SEARCH_LIMIT = 100

// 🎯 Cache for database schema
let schemaCache: string[] | null = null

// In-memory caches
let filterCache: FilterCache | null = null
const CACHE_TTL = 1000 * 60 * 60 * 24

// 🆕 Query enhancement cache
const queryEnhancementCache = new Map<string, EnhancedQuery>()
const QUERY_CACHE_TTL = 1000 * 60 * 60 // 1 hour

// ============================================================================
// DATABASE UTILITIES
// ============================================================================

async function getDatabaseColumns(): Promise<string[]> {
  if (schemaCache) {
    return schemaCache
  }

  try {
    const { data, error } = await supabase
      .from('coatings')
      .select('*')
      .limit(1)

    if (error || !data || data.length === 0) {
      console.error('❌ Failed to get database schema')
      return ['sku', 'family', 'Product_Name', 'Product_Type', 'Product_Model', 'Product_Description']
    }

    const columns = Object.keys(data[0])
    schemaCache = columns
    console.log(`✅ Database columns detected: ${columns.length} fields`)

    return columns
  } catch (error) {
    console.error('❌ Error getting database columns:', error)
    return ['sku', 'family', 'Product_Name', 'Product_Type', 'Product_Model', 'Product_Description']
  }
}

function cleanProductData(product: ProductRecord): ProductRecord {
  const cleaned: ProductRecord = {}

  Object.entries(product).forEach(([key, value]) => {
    if (value !== null && value !== undefined) {
      if (typeof value === 'string') {
        let cleanedValue = value
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/p>/gi, '\n\n')
          .replace(/<li>/gi, '• ')
          .replace(/<\/li>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&reg;/gi, '®')
          .replace(/&trade;/gi, '™')
          .replace(/&copy;/gi, '©')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/gi, '&')
          .replace(/&lt;/gi, '<')
          .replace(/&gt;/gi, '>')
          .replace(/&quot;/gi, '"')
          .replace(/&#39;/gi, "'")
          .replace(/&rsquo;/gi, "'")
          .replace(/&lsquo;/gi, "'")
          .replace(/&rdquo;/gi, '"')
          .replace(/&ldquo;/gi, '"')
          .replace(/&deg;/gi, '°')
          .replace(/&plusmn;/gi, '±')
          .replace(/&times;/gi, '×')
          .replace(/&divide;/gi, '÷')
          .replace(/&ndash;/gi, '–')
          .replace(/&mdash;/gi, '—')
          .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec))
          .replace(/&#x([0-9a-f]+);/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)))
          .replace(/\n{3,}/g, '\n\n')
          .trim()

        if (cleanedValue !== '') {
          cleaned[key] = cleanedValue
        }
      } else {
        cleaned[key] = value
      }
    }
  })

  return cleaned
}

// ============================================================================
// FILTER OPTIONS & CACHING
// ============================================================================

async function fetchAllDistinctValues(columnName: string): Promise<string[]> {
  console.log(`  📊 Fetching all distinct values for: ${columnName}`)

  const allValues = new Set<string>()
  let page = 0
  const pageSize = 1000
  let hasMore = true

  while (hasMore) {
    const from = page * pageSize
    const to = from + pageSize - 1

    try {
      const { data, error } = await supabase
        .from('coatings')
        .select(columnName)
        .not(columnName, 'is', null)
        .neq(columnName, '')
        .order(columnName)
        .range(from, to)

      if (error || !data || data.length === 0) break

      data.forEach((row: any) => {
        const value = row[columnName]
        if (value && typeof value === 'string' && value.trim() !== '') {
          allValues.add(value.trim())
        }
      })

      if (data.length < pageSize) {
        hasMore = false
      } else {
        page++
      }

      if (page > 100) break

    } catch (err) {
      console.error(`  ❌ Exception fetching ${columnName}:`, err)
      break
    }
  }

  const sortedValues = Array.from(allValues).sort()
  console.log(`  ✅ ${columnName}: ${sortedValues.length} unique values`)

  return sortedValues
}

async function getFilterOptions(forceRefresh: boolean = false): Promise<any> {
  if (!forceRefresh && filterCache) {
    const now = Date.now()
    const cacheAge = now - filterCache.timestamp

    if (cacheAge < filterCache.ttl) {
      return {
        success: true,
        cached: true,
        filterOptions: {
          families: filterCache.families,
          productTypes: filterCache.productTypes,
          productModels: filterCache.productModels
        }
      }
    }
  }

  try {
    const [families, types, models] = await Promise.all([
      fetchAllDistinctValues('family'),
      fetchAllDistinctValues('Product_Type'),
      fetchAllDistinctValues('Product_Model')
    ])

    filterCache = {
      families,
      productTypes: types,
      productModels: models,
      timestamp: Date.now(),
      ttl: CACHE_TTL
    }

    return {
      success: true,
      cached: false,
      filterOptions: {
        families,
        productTypes: types,
        productModels: models
      }
    }
  } catch (error: any) {
    console.error('❌ Error fetching filter options:', error)

    if (filterCache) {
      return {
        success: true,
        cached: true,
        expired: true,
        filterOptions: {
          families: filterCache.families,
          productTypes: filterCache.productTypes,
          productModels: filterCache.productModels
        }
      }
    }

    return {
      success: false,
      error: 'Failed to fetch filter options',
      filterOptions: { families: [], productTypes: [], productModels: [] }
    }
  }
}

// ============================================================================
// 🆕 AI-POWERED QUERY ENHANCEMENT
// ============================================================================

async function enhanceQueryWithAI(userQuery: string): Promise<EnhancedQuery> {
  // Check cache first
  const cacheKey = userQuery.toLowerCase().trim()
  const cached = queryEnhancementCache.get(cacheKey)
  
  if (cached) {
    console.log(`✅ Using cached query enhancement`)
    return cached
  }

  console.log(`🧠 AI enhancing query: "${userQuery}"`)

  const systemPrompt = `You are a coating/sealant product domain expert. Analyze the user's query and enhance it for better product search.

Return JSON with:
{
  "originalQuery": "user's original query",
  "enhancedQuery": "expanded query with technical terms and synonyms (max 150 words)",
  "searchIntent": "what the user is really looking for",
  "domainTerms": ["5-10 technical terms related to the query"],
  "technicalRequirements": ["specific product requirements"],
  "expectedProductTypes": ["types of products that would match"]
}

DOMAIN KNOWLEDGE FOR COATINGS:
- Corrosion prevention → corrosion resistant, anti-corrosion, rust inhibitor, zinc-rich primer, epoxy coating, chemical resistant, protective coating, metal protection
- Fuel tank → fuel resistant, aviation fuel, chemical resistant, tank lining, polysulfide sealant
- Exterior → weathering resistant, UV resistant, outdoor, environmental exposure, topcoat
- Flexible → elastomeric, pliable, movement accommodation, resilient
- High temperature → heat resistant, thermal stability, fire resistant
- Adhesion → bonding, substrate adhesion, primer, surface preparation
- Sealing → gap filling, air sealing, moisture barrier, waterproof
- Primer → base coat, undercoat, surface preparation, adhesion promoter
- Topcoat → finish coat, protective layer, final coating
- Conductive → EMI shielding, static dissipative, electrical conductivity

EXAMPLES:
Query: "best coating for corrosion prevention"
→ Enhanced: "corrosion resistant coating anti-corrosion rust prevention epoxy primer polyurethane topcoat chemical resistant protective coating metal protection zinc-rich primer corrosion inhibitor"
→ Domain terms: ["corrosion resistant", "anti-corrosion", "rust prevention", "protective coating", "epoxy primer"]
→ Expected types: ["Epoxy Primer", "Corrosion Inhibitive Primer", "Polyurethane Topcoat", "Zinc-Rich Primer", "Protective Coating"]

Query: "flexible sealant for fuel tanks"
→ Enhanced: "flexible elastomeric sealant fuel resistant aviation fuel chemical resistant tank sealant polysulfide fuel system sealing compound"
→ Domain terms: ["fuel resistant", "elastomeric", "chemical resistant", "aviation fuel", "polysulfide"]
→ Expected types: ["Polysulfide Sealant", "Fuel Tank Sealant", "Chemical Resistant Sealant", "Elastomeric Sealant"]

Query: "thinner"
→ Enhanced: "thinner reducer solvent cleaning agent dilution coating thinner paint thinner"
→ Domain terms: ["thinner", "reducer", "solvent", "dilution"]
→ Expected types: ["Thinner", "Reducer", "Solvent", "Cleaning Agent"]`

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini', // Faster and cheaper
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Enhance this query for coating product search: "${userQuery}"` }
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' }
    })

    const enhanced = JSON.parse(completion.choices[0].message.content || '{}') as EnhancedQuery

    console.log(`✅ Query enhanced:`)
    console.log(`   Original: "${enhanced.originalQuery}"`)
    console.log(`   Enhanced: "${enhanced.enhancedQuery?.substring(0, 100)}..."`)
    console.log(`   Intent: ${enhanced.searchIntent}`)
    console.log(`   Domain terms: ${enhanced.domainTerms?.slice(0, 5).join(', ')}...`)
    console.log(`   Expected types: ${enhanced.expectedProductTypes?.slice(0, 3).join(', ')}...`)

    // Cache the result
    queryEnhancementCache.set(cacheKey, enhanced)
    
    // Auto-cleanup old cache entries
    setTimeout(() => {
      queryEnhancementCache.delete(cacheKey)
    }, QUERY_CACHE_TTL)

    return enhanced
  } catch (error) {
    console.error('❌ Query enhancement failed:', error)
    return {
      originalQuery: userQuery,
      enhancedQuery: userQuery,
      searchIntent: 'lookup',
      domainTerms: [],
      technicalRequirements: [],
      expectedProductTypes: []
    }
  }
}

// ============================================================================
// SEMANTIC SEARCH
// ============================================================================

async function generateEmbedding(text: string): Promise<number[]> {
  try {
    console.log(`🧠 Generating embedding for: "${text.substring(0, 50)}..."`)
    
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text,
    })
    
    console.log(`✅ Embedding generated (${response.data[0].embedding.length} dimensions)`)
    return response.data[0].embedding
  } catch (error) {
    console.error('❌ Embedding generation failed:', error)
    return []
  }
}

async function executeSemanticSearch(
  queryText: string,
  appliedFilters: any,
  enhancedQuery: EnhancedQuery | null = null,
  limit: number = SEMANTIC_SEARCH_LIMIT
): Promise<ProductRecord[]> {
  console.log(`🧠 Executing semantic search for: "${queryText}"`)

  try {
    // 🎯 Use enhanced query if available
    const searchText = enhancedQuery?.enhancedQuery || queryText
    console.log(`📝 Using ${enhancedQuery ? 'enhanced' : 'original'} query for embedding`)

    const queryEmbedding = await generateEmbedding(searchText)

    if (queryEmbedding.length === 0) {
      console.log('⚠️ Semantic search failed, no embedding generated')
      return []
    }

    console.log(`✅ Query embedding generated: ${queryEmbedding.length} dimensions`)

    const columns = await getDatabaseColumns()
    if (!columns.includes('embedding')) {
      console.log('⚠️ Semantic search unavailable: embedding column not found')
      return []
    }

    // 🎯 Lower thresholds for better recall
    const thresholds = [0.45, 0.35, 0.25, 0.20]

    for (const threshold of thresholds) {
      console.log(`🔍 Trying semantic search with threshold: ${threshold}`)

      try {
        const embeddingString = `[${queryEmbedding.join(',')}]`

        const { data, error } = await supabase.rpc('match_coatings', {
          query_embedding: embeddingString,
          match_threshold: threshold,
          match_count: limit
        })

        if (error) {
          console.error(`❌ Semantic search error at threshold ${threshold}:`, error)
          
          if (error.message?.includes('function match_coatings') || error.code === '42883') {
            console.error('❌ RPC function "match_coatings" does not exist!')
            return []
          }
          
          continue
        }

        if (!data || !Array.isArray(data) || data.length === 0) {
          console.log(`⚠️ Semantic search returned 0 results at threshold ${threshold}`)
          continue
        }

        console.log(`✅ Semantic search found ${data.length} products at threshold ${threshold}`)
        console.log(`   Top 5 similarities:`, data.slice(0, 5).map((d: any) => 
          `${d.similarity?.toFixed(3)} - ${d.Product_Type || 'N/A'}`
        ).join(', ')
        )

        let filtered = data

        // 🎯 NEW: Re-rank results based on expected product types
        if (enhancedQuery?.expectedProductTypes && enhancedQuery.expectedProductTypes.length > 0) {
          filtered = filtered.map((product: any) => {
            const productType = (product.Product_Type || '').toLowerCase()
            const productName = (product.Product_Name || '').toLowerCase()
            const description = (product.Product_Description || '').toLowerCase()
            
            let typeBoost = 0
            
            // Boost for expected product types
            enhancedQuery.expectedProductTypes.forEach(expectedType => {
              const lowerExpected = expectedType.toLowerCase()
              if (productType.includes(lowerExpected) || lowerExpected.includes(productType)) {
                typeBoost += 0.15 // Boost similarity by 15%
              }
              if (productName.includes(lowerExpected)) {
                typeBoost += 0.10 // Boost similarity by 10%
              }
            })

            // Boost for domain terms in description
            enhancedQuery.domainTerms?.forEach(term => {
              const lowerTerm = term.toLowerCase()
              if (description.includes(lowerTerm)) {
                typeBoost += 0.05 // Boost similarity by 5%
              }
            })

            return {
              ...product,
              similarity: Math.min(1.0, (product.similarity || 0) + typeBoost),
              _boosted: typeBoost > 0,
              _boostAmount: typeBoost
            }
          }).sort((a: any, b: any) => (b.similarity || 0) - (a.similarity || 0))

          console.log(`   🎯 Re-ranked with AI boost`)
          console.log(`   Top 5 after boost:`, filtered.slice(0, 5).map((d: any) => 
            `${d.similarity?.toFixed(3)} - ${d.Product_Type}${d._boosted ? ` ⭐+${(d._boostAmount * 100).toFixed(0)}%` : ''}`
          ).join(', '))
        }

        // Apply user filters
        if (appliedFilters.family) {
          const beforeCount = filtered.length
          filtered = filtered.filter((p: any) => p.family === appliedFilters.family)
          console.log(`   Family filter "${appliedFilters.family}": ${beforeCount} → ${filtered.length} products`)
        }

        if (appliedFilters.productType) {
          const beforeCount = filtered.length
          filtered = filtered.filter((p: any) => p.Product_Type === appliedFilters.productType)
          console.log(`   Type filter "${appliedFilters.productType}": ${beforeCount} → ${filtered.length} products`)
        }

        if (appliedFilters.productModel) {
          const beforeCount = filtered.length
          filtered = filtered.filter((p: any) => p.Product_Model === appliedFilters.productModel)
          console.log(`   Model filter "${appliedFilters.productModel}": ${beforeCount} → ${filtered.length} products`)
        }

        if (filtered.length > 0) {
          console.log(`✅ Returning ${filtered.length} filtered results`)
          
          // 🎯 Attach enhanced query metadata for answer generation
          filtered.forEach((product: any) => {
            product._enhancedQuery = enhancedQuery
            product._source = 'semantic'
          })
          
          return filtered
        }

        console.log(`⚠️ All ${data.length} results filtered out by applied filters`)
      } catch (rpcError: any) {
        console.error(`❌ RPC call failed at threshold ${threshold}:`, rpcError)
        continue
      }
    }

    console.log('⚠️ Semantic search exhausted all thresholds')
    return []

  } catch (error: any) {
    console.error('❌ Semantic search failed with exception:', error)
    return []
  }
}

// ============================================================================
// AI QUERY PLANNING
// ============================================================================

async function planQuery(userQuery: string, appliedFilters: any): Promise<AIQueryPlan> {
  console.log(`🤖 AI analyzing query: "${userQuery}"`)

  const systemPrompt = `Analyze user query and return JSON:
{
  "intent": "comparison|lookup|list|count|analytical",
  "searchTerms": ["term1", "term2"],
  "filters": {"productType": "optional", "productModel": "optional", "family": "optional"},
  "requiresMultipleProducts": true/false,
  "explanation": "brief explanation"
}

Intent types:
- comparison: Compare 2+ products
- lookup: Info about specific product(s)
- list: All products matching criteria
- count: How many products
- analytical: Recommendations/advice

IMPORTANT: For SKU comparisons, keep SKUs as complete search terms (e.g., ["8211FCLEARCAX22K", "8211FCLEARCAY22K"])`

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Query: "${userQuery}"\nFilters: ${JSON.stringify(appliedFilters)}` }
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' }
    })

    const plan = JSON.parse(completion.choices[0].message.content || '{}') as AIQueryPlan
    console.log(`✅ AI Query Plan:`, plan)
    return plan
  } catch (error) {
    console.error('❌ AI planning failed:', error)
    return {
      intent: 'lookup',
      searchTerms: [userQuery],
      requiresMultipleProducts: false,
      explanation: 'Fallback'
    }
  }
}

// ============================================================================
// SMART SEARCH LOGIC
// ============================================================================

function detectSKUs(searchTerms: string[]): string[] {
  const skuPattern = /^[A-Z0-9]{8,}$/i
  return searchTerms.filter(term => {
    const cleanTerm = term.trim().replace(/[^A-Z0-9]/gi, '')
    return skuPattern.test(cleanTerm)
  })
}

function analyzeQuery(searchPhrase: string, searchWords: string[]): QueryAnalysis {
  const wordCount = searchWords.length
  const isSingleWord = wordCount === 1
  const isMultiWord = wordCount > 1

  const requiresAllWords = isMultiWord && wordCount === 2

  let searchStrategy: 'semantic-first' | 'keyword-first' | 'hybrid' = 'semantic-first'
  
  if (isSingleWord) {
    searchStrategy = 'keyword-first'
  } else if (wordCount >= 3) {
    searchStrategy = 'hybrid'
  }

  return {
    isSingleWord,
    isMultiWord,
    wordCount,
    requiresAllWords,
    searchStrategy
  }
}

async function executeSmartSearch(
  plan: AIQueryPlan, 
  appliedFilters: any,
  enhancedQuery: EnhancedQuery | null = null
): Promise<ProductRecord[]> {
  console.log(`⚡ Executing smart search for: ${plan.searchTerms.join(', ')}`)

  const allResults: ProductRecord[] = []
  const seenIds = new Set<string>()

  const allColumns = await getDatabaseColumns()

  const searchPhrase = plan.searchTerms.join(' ')
  const searchWords = searchPhrase.toLowerCase().split(/\s+/).filter(w => w.length > 2)

  console.log(`🔍 Search phrase: "${searchPhrase}"`)
  console.log(`🔍 Search words: ${searchWords.join(', ')}`)

  const queryAnalysis = analyzeQuery(searchPhrase, searchWords)
  console.log(`🧠 Query Analysis:`, queryAnalysis)

  // ============================================================================
  // 🎯 STRATEGY 0: EXACT SKU MATCH
  // ============================================================================
  
  console.log(`\n🎯 STRATEGY 0: Exact SKU Match...`)
  const potentialSKUs = detectSKUs(plan.searchTerms)
  
  if (potentialSKUs.length > 0) {
    console.log(`  🏷️ Detected ${potentialSKUs.length} potential SKU(s): ${potentialSKUs.join(', ')}`)
    
    for (const skuTerm of potentialSKUs) {
      const cleanSKU = skuTerm.trim().toUpperCase()
      
      try {
        let query = supabase.from('coatings').select('*')

        if (appliedFilters.family) query = query.eq('family', appliedFilters.family)
        if (appliedFilters.productType) query = query.eq('Product_Type', appliedFilters.productType)
        if (appliedFilters.productModel) query = query.eq('Product_Model', appliedFilters.productModel)

        query = query.or(`sku.ilike.${cleanSKU},Product_Model.ilike.${cleanSKU},Product_Name.ilike.${cleanSKU}`)

        const { data, error } = await query.limit(10)

        if (data && data.length > 0) {
          console.log(`  ✅ Found ${data.length} exact SKU match(es)`)
          data.forEach((item: any) => {
            const id = item.sku || JSON.stringify(item)
            if (!seenIds.has(id)) {
              seenIds.add(id)
              allResults.push({ ...item, _source: 'sku', _score: 1000 })
            }
          })
        }
      } catch (err) {
        console.error(`  ❌ SKU search failed:`, err)
      }
    }

    if (allResults.length > 0) {
      console.log(`✅ Returning ${allResults.length} SKU matches`)
      return allResults
    }
  }

  // ============================================================================
  // 🎯 STRATEGY 1: SEMANTIC SEARCH (with AI enhancement)
  // ============================================================================

  console.log(`\n🧠 STRATEGY 1: Semantic Search (${queryAnalysis.searchStrategy})...`)
  
  try {
    const semanticResults = await executeSemanticSearch(
      searchPhrase,
      appliedFilters,
      enhancedQuery,
      SEMANTIC_SEARCH_LIMIT
    )

    if (semanticResults.length > 0) {
      console.log(`✅ Semantic search found ${semanticResults.length} products`)
      
      semanticResults.forEach((item: any) => {
        const id = item.sku || JSON.stringify(item)
        if (!seenIds.has(id)) {
          seenIds.add(id)
          allResults.push(item)
        }
      })
    } else {
      console.log(`⚠️ Semantic search returned 0 results`)
    }
  } catch (err) {
    console.error(`❌ Semantic search failed:`, err)
  }

  // ============================================================================
  // 🎯 STRATEGY 2: SMART KEYWORD SEARCH (with AI-enhanced terms)
  // ============================================================================

  console.log(`\n🔍 STRATEGY 2: Smart Keyword Search...`)

  try {
    let query = supabase.from('coatings').select('*')

    if (appliedFilters.family) query = query.eq('family', appliedFilters.family)
    if (appliedFilters.productType) query = query.eq('Product_Type', appliedFilters.productType)
    if (appliedFilters.productModel) query = query.eq('Product_Model', appliedFilters.productModel)

    // 🎯 Use enhanced domain terms if available
    const searchTermsToUse = enhancedQuery?.domainTerms?.length 
      ? [...searchWords, ...enhancedQuery.domainTerms.map(t => t.toLowerCase())]
      : searchWords

    const uniqueTerms = [...new Set(searchTermsToUse)].slice(0, 15) // Limit to prevent query overload

    const orConditions: string[] = []

    uniqueTerms.forEach(term => {
      if (allColumns.includes('Product_Type')) orConditions.push(`Product_Type.ilike.%${term}%`)
      if (allColumns.includes('Product_Model')) orConditions.push(`Product_Model.ilike.%${term}%`)
      if (allColumns.includes('Product_Name')) orConditions.push(`Product_Name.ilike.%${term}%`)
      if (allColumns.includes('Product_Description')) orConditions.push(`Product_Description.ilike.%${term}%`)
      if (allColumns.includes('Application')) orConditions.push(`Application.ilike.%${term}%`)
      if (allColumns.includes('Features')) orConditions.push(`Features.ilike.%${term}%`)
    })

    if (orConditions.length > 0) {
      query = query.or(orConditions.join(','))
    }

    const { data, error } = await query.limit(500)

    console.log(`📊 Keyword search: ${data?.length || 0} raw matches`)

    if (data && data.length > 0) {
      const scoredResults = data.map(item => {
        const productType = (item.Product_Type || '').toLowerCase()
        const productModel = (item.Product_Model || '').toLowerCase()
        const productName = (item.Product_Name || '').toLowerCase()
        const description = (item.Product_Description || '').toLowerCase()
        const application = (item.Application || '').toLowerCase()
        const features = (item.Features || '').toLowerCase()

        let score = 0
        const exactPhrase = searchPhrase.toLowerCase()

        // 🎯 Bonus for enhanced domain terms
        if (enhancedQuery?.domainTerms) {
          enhancedQuery.domainTerms.forEach(term => {
            const lowerTerm = term.toLowerCase()
            if (productType.includes(lowerTerm)) score += 150
            if (productName.includes(lowerTerm)) score += 100
            if (description.includes(lowerTerm)) score += 80
            if (application.includes(lowerTerm)) score += 80
            if (features.includes(lowerTerm)) score += 60
          })
        }

        // 🎯 Bonus for expected product types
        if (enhancedQuery?.expectedProductTypes) {
          enhancedQuery.expectedProductTypes.forEach(expectedType => {
            const lowerExpected = expectedType.toLowerCase()
            if (productType.includes(lowerExpected) || lowerExpected.includes(productType)) {
              score += 200
            }
            if (productName.includes(lowerExpected)) {
              score += 150
            }
          })
        }

        // Exact phrase matches
        if (productType === exactPhrase) score += 1000
        else if (productType.includes(exactPhrase)) score += 500

        if (productModel === exactPhrase) score += 800
        else if (productModel.includes(exactPhrase)) score += 400

        if (productName === exactPhrase) score += 600
        else if (productName.includes(exactPhrase)) score += 300

        // Match original search words
        const matchedWords = searchWords.filter(word =>
          productType.includes(word) || 
          productModel.includes(word) ||
          productName.includes(word) ||
          description.includes(word) ||
          application.includes(word) ||
          features.includes(word)
        )

        // 🎯 More lenient scoring
        if (queryAnalysis.isSingleWord) {
          if (matchedWords.length === 0) return { item, score: 0 }
          
          searchWords.forEach(word => {
            if (productType.includes(word)) score += 50
            if (productModel.includes(word)) score += 40
            if (productName.includes(word)) score += 30
            if (description.includes(word)) score += 10
            if (application.includes(word)) score += 20
          })
        } else {
          // 🎯 Require only 40% word match (was 60%)
          const minRequired = Math.max(1, Math.floor(searchWords.length * 0.4))
          if (matchedWords.length < minRequired) {
            return { item, score: 0 }
          }

          score += matchedWords.length * 30

          const allText = `${productType} ${productModel} ${productName} ${description} ${application}`
          if (allText.includes(exactPhrase)) {
            score += 200
          }
        }

        return { item, score, matchedWords: matchedWords.length }
      })

      // 🎯 Lower minimum score threshold
      const minScore = queryAnalysis.isSingleWord ? 20 : 50
      const maxResults = queryAnalysis.isSingleWord ? 100 : 50

      const filtered = scoredResults
        .filter(r => r.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults)
        .map(r => ({ ...r.item, _source: 'keyword', _score: r.score }))

      console.log(`✅ Keyword search: ${filtered.length} relevant products (from ${data.length} raw)`)
      console.log(`📊 Top 5 scores:`, scoredResults
        .filter(r => r.score >= minScore)
        .slice(0, 5)
        .map(r => `${r.score}pts - ${r.item.Product_Type}`)
        .join(', ')
      )

      filtered.forEach((item: any) => {
        const id = item.sku || JSON.stringify(item)
        if (!seenIds.has(id)) {
          seenIds.add(id)
          allResults.push(item)
        }
      })
    }
  } catch (err) {
    console.error(`❌ Keyword search failed:`, err)
  }

  console.log(`✅ Returning ${allResults.length} total results (semantic + keyword)`)
  return allResults
}

// ============================================================================
// ANSWER GENERATION
// ============================================================================

function prepareEssentialProductData(products: ProductRecord[], maxProducts: number = MAX_DETAILED_PRODUCTS): string {
  const limitedProducts = products.slice(0, maxProducts)
  
  const essentialData = limitedProducts.map((p, idx) => {
    const essential: any = {
      index: idx + 1,
      sku: p.sku || 'N/A',
      type: p.Product_Type || 'N/A',
      name: p.Product_Name || 'N/A',
      model: p.Product_Model || 'N/A',
    }

    // Include key fields if they exist
    if (p.Product_Description) {
      essential.description = String(p.Product_Description).substring(0, MAX_FIELD_LENGTH)
    }
    if (p.Application) {
      essential.application = String(p.Application).substring(0, MAX_FIELD_LENGTH)
    }
    if (p.Features) {
      essential.features = String(p.Features).substring(0, MAX_FIELD_LENGTH)
    }

    return essential
  })

  return JSON.stringify(essentialData, null, 2)
}

async function generateAnswer(
  query: string,
  products: ProductRecord[],
  intent: string,
  enhancedQuery: EnhancedQuery | null = null
): Promise<string> {
  console.log(`🤖 AI generating answer for ${products.length} products`)

  if (products.length === 0) {
    return "I couldn't find any products matching your search. Please try different search terms or adjust your filters."
  }

  const approach = products.length <= MAX_DETAILED_PRODUCTS ? 'DETAILED ANALYSIS' : 'SUMMARY'
  console.log(`⚡ ${approach} approach (${products.length} products)`)

  const productData = prepareEssentialProductData(products)

  // 🎯 Enhanced system prompt with query context
  const systemPrompt = `You are a coating/sealant product expert. Provide a helpful answer based on the products found.

USER'S SEARCH CONTEXT:
- Original query: "${enhancedQuery?.originalQuery || query}"
- Search intent: "${enhancedQuery?.searchIntent || intent}"
- Technical requirements: ${enhancedQuery?.technicalRequirements?.join(', ') || 'not specified'}
- Expected product types: ${enhancedQuery?.expectedProductTypes?.join(', ') || 'any'}
- Domain terms searched: ${enhancedQuery?.domainTerms?.slice(0, 5).join(', ') || 'none'}

INSTRUCTIONS:
1. **Address the user's actual intent**, not just list products
2. **Explain WHY these products match** their requirements
3. **Highlight key features** relevant to their query
4. **Provide recommendations** if multiple products found
5. **Be honest** if products don't perfectly match (suggest alternatives)
6. **Use the enhanced query context** to provide more relevant answers

FORMAT:
- Use markdown (headers, lists, tables)
- Start with a direct answer to their question
- Then provide supporting details
- End with actionable recommendations
- Keep it concise but informative

EXAMPLE (for "best coating for corrosion prevention"):
"For corrosion prevention, I found [X] products that offer excellent protection:

## Top Recommendations

**1. [Product Name] (SKU: XXX)**
- **Why it's ideal**: Contains corrosion inhibitors and provides long-term protection
- **Key features**: Chemical resistant, adheres to metal substrates
- **Best for**: Exterior metal surfaces exposed to harsh environments

[Continue with other products...]

## Selection Guidance
- For maximum protection: Choose epoxy primers with zinc-rich formulation
- For flexibility: Consider polyurethane topcoats
- For specific environments: [provide context-specific advice]"

Now analyze these ${products.length} products and provide a helpful answer:`

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Query: "${query}"\n\nProducts found:\n${productData}` }
      ],
      temperature: 0.3,
      max_tokens: 2000
    })

    const answer = completion.choices[0].message.content || 'Unable to generate answer.'
    console.log(`✅ Answer generated (${answer.length} chars)`)
    
    return answer
  } catch (error) {
    console.error('❌ Answer generation failed:', error)
    return `Found ${products.length} products matching your search. Please review the product list below for details.`
  }
}

// ============================================================================
// MAIN API HANDLER
// ============================================================================

export async function POST(request: NextRequest) {
  const startTime = Date.now()
  
  try {
    const body = await request.json()
    const { query, filters, getFilterOptions: requestFilterOptions } = body

    console.log('================================================================================')
    console.log(`🔍 User query: ${query}`)
    console.log(`🎯 Applied filters:`, filters || {})

    // Handle filter options request
    if (requestFilterOptions || query === '__GET_FILTER_OPTIONS__') {
      console.log('📋 Fetching filter options...')
      const filterOptions = await getFilterOptions()
      return NextResponse.json(filterOptions)
    }

    if (!query || typeof query !== 'string' || query.trim() === '') {
      return NextResponse.json({
        success: false,
        error: 'Query is required'
      }, { status: 400 })
    }

    const appliedFilters = {
      family: filters?.family || '',
      productType: filters?.productType || '',
      productModel: filters?.productModel || ''
    }

    // 🆕 Step 1: Enhance query with AI
    const enhancedQuery = await enhanceQueryWithAI(query)

    // Step 2: Plan query
    const plan = await planQuery(query, appliedFilters)
    console.log(`> 🎯 AI determined intent: ${plan.intent}`)
    console.log(`> 🔑 Search terms: ${plan.searchTerms.join(', ')}`)

    // Step 3: Execute smart search with enhanced query
    const products = await executeSmartSearch(plan, appliedFilters, enhancedQuery)
    console.log(`> ✅ Found ${products.length} products`)

    // Step 4: Generate AI answer with enhanced context
    const answer = await generateAnswer(query, products, plan.intent, enhancedQuery)

    const endTime = Date.now()
    const duration = ((endTime - startTime) / 1000).toFixed(1)

    console.log('================================================================================')
    console.log(`✅ Search completed in ${duration}s`)
    console.log('')

    return NextResponse.json({
      success: true,
      answer,
      products: products.map(cleanProductData),
      intent: plan.intent,
      searchTerms: plan.searchTerms,
      enhancedQuery: enhancedQuery.enhancedQuery,
      expectedTypes: enhancedQuery.expectedProductTypes,
      totalResults: products.length,
      searchTime: parseFloat(duration)
    })

  } catch (error: any) {
    console.error('❌ Search error:', error)
    
    return NextResponse.json({
      success: false,
      error: error.message || 'An error occurred during search',
      products: [],
      totalResults: 0
    }, { status: 500 })
  }
}
